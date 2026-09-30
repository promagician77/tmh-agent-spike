import { TmhApi, directory, Forbidden, NotFound } from './tmh-api.js';
import { decide, MIN_CONFIDENCE, HELPER_REPLY_MINUTES } from './policy.js';
import { DAYS } from './interpret.js';

// The orchestrator. Everything it needs to resume lives in `store`, a plain JSON
// object (a database table in production). Waiting for a helper is a row with a
// deadline, not a sleeping process, so a restart mid-conversation loses nothing.

export function emptyStore() {
  return { seen: {}, workflows: {}, asks: {}, escalations: [], audit: [], seq: 0 };
}

const fmtTime = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).replace(':00', '');
const fmtWin = (w) => `${fmtTime(w.start)}-${new Date(w.end).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).replace(':00', '')}`;

export class Engine {
  constructor({ db, store = emptyStore(), clock, interpreter, sms, calendar, onEvent = () => {} }) {
    Object.assign(this, { db, store, clock, interpreter, sms, calendar, onEvent });
    this.whois = directory(db);
  }

  // ---------- plumbing ----------
  now() { return this.clock.now(); }
  id(prefix) { return `${prefix}_${++this.store.seq}`; }
  api(opId) { return new TmhApi(this.db, opId); }
  audit(wf, actor, action, detail) {
    const entry = { at: this.now(), operatorId: wf?.operatorId ?? null, workflowId: wf?.id ?? null, actor, action, detail };
    this.store.audit.push(entry);
    this.onEvent({ kind: 'audit', ...entry });
  }
  send(wf, to, text) {
    this.sms.send(to, text);
    this.audit(wf, 'agent', 'sms.sent', `to ${to}: ${text}`);
    this.onEvent({ kind: 'out', to, text });
  }
  ask(wf, phone, text, state, extra = {}) {
    this.send(wf, phone, text);
    this.store.asks[phone] = { workflowId: wf.id, expiresAt: new Date(new Date(this.now()).getTime() + HELPER_REPLY_MINUTES * 6e4).toISOString() };
    Object.assign(wf, { state, waitingOn: phone, ...extra });
    this.audit(wf, 'agent', 'wait', `waiting on ${phone} until ${this.store.asks[phone].expiresAt.slice(11, 16)}`);
  }
  clearAsk(phone) { delete this.store.asks[phone]; }
  escalate(wf, reason, summary, recommended, proposed = null) {
    const esc = { id: this.id('esc'), operatorId: wf.operatorId, workflowId: wf.id, kind: proposed ? 'approval' : 'escalation', reason, summary, recommended, proposed, status: 'open' };
    this.store.escalations.push(esc);
    wf.state = proposed ? 'awaiting_operator_approval' : 'escalated';
    this.audit(wf, 'agent', proposed ? 'approval.requested' : 'escalated', `${reason} Recommended: ${recommended}`);
    this.onEvent({ ...esc, escType: esc.kind, kind: 'escalation' });
    return esc;
  }
  newWorkflow(type, who, trigger) {
    const wf = { id: this.id('wf'), type, operatorId: who.operatorId, sender: who, trigger, state: 'started', data: {} };
    this.store.workflows[wf.id] = wf;
    this.audit(wf, who.kind, 'workflow.started', `${type} from "${trigger}"`);
    return wf;
  }
  resolveDay(day) {
    const now = new Date(this.now());
    if (!day || day === 'today') return now.toISOString().slice(0, 10);
    if (day === 'tomorrow') return new Date(now.getTime() + 864e5).toISOString().slice(0, 10);
    const target = DAYS.indexOf(day);
    const diff = (target - now.getUTCDay() + 7) % 7;
    return new Date(now.getTime() + diff * 864e5).toISOString().slice(0, 10);
  }

  // ---------- entry point: a Quo webhook or parsed email ----------
  async handleInbound({ messageId, from, text }) {
    if (this.store.seen[messageId]) {
      this.audit(null, 'system', 'duplicate.ignored', `message ${messageId} already processed`);
      return { duplicate: true };
    }
    this.store.seen[messageId] = this.now();
    this.onEvent({ kind: 'in', from, text });
    const who = this.whois(from);
    if (!who) { this.audit(null, 'system', 'unknown.sender', from); return { unknown: true }; }

    const intent = await this.interpreter.interpret({ text, role: who.kind, context: { today: this.now().slice(0, 10) } });
    this.audit({ operatorId: who.operatorId }, 'agent', 'interpreted', `${intent.intent}${intent.answer ? ':' + intent.answer : ''} (${Math.round(intent.confidence * 100)}%) via ${this.interpreter.name}`);

    const pending = this.store.asks[from];
    if (pending && intent.intent === 'answer') {
      this.clearAsk(from);
      const wf = this.store.workflows[pending.workflowId];
      this.audit(wf, who.kind, 'reply', `"${text}"`);
      return this.advance(wf, intent.answer);
    }
    if (who.kind === 'helper') return this.startHelper(who, text, intent);
    return this.startClient(who, text, intent);
  }

  // ---------- client requests ----------
  async startClient(who, text, intent) {
    const wf = this.newWorkflow(intent.intent, who, text);
    const api = this.api(who.operatorId);
    const client = api.client(who.id);
    const op = this.db.operators[who.operatorId];

    if (['refund', 'complaint'].includes(intent.intent)) {
      this.escalate(wf, `${intent.intent === 'refund' ? 'Payment/refund' : 'Complaint'} - always handled by a person.`,
        `${client.name} wrote: "${text}"`, `${op.contact} to reply personally today.`);
      this.send(wf, client.phone, `Thanks, ${client.name.split(' ')[0]}. I've passed this to ${op.contact.split(' ')[0]}, who'll get back to you today.`);
      return wf;
    }
    if (intent.confidence < MIN_CONFIDENCE || !['cancel', 'reschedule'].includes(intent.intent)) {
      this.send(wf, client.phone, `Happy to help! Which appointment do you mean, and what would you like to change?`);
      wf.state = 'clarifying';
      this.audit(wf, 'agent', 'clarify', `confidence ${Math.round(intent.confidence * 100)}% is below ${MIN_CONFIDENCE * 100}%`);
      return wf;
    }

    // Find the appointment. An explicit id goes through the scoped API like everything else.
    let appt;
    try {
      appt = intent.appointmentId ? api.appointment(intent.appointmentId)
        : api.upcomingForClient(client.id, this.now()).find((a) => a.start.slice(0, 10) === this.resolveDay(intent.day));
    } catch (e) {
      if (e instanceof Forbidden || e instanceof NotFound) {
        this.audit(wf, 'api', 'blocked', `${e.status}: ${e.message}`);
        this.escalate(wf, 'Request referenced an appointment outside this operator.', `${client.name} wrote: "${text}"`, 'Review the message; possible mistake or abuse.');
        this.send(wf, client.phone, `I couldn't find that appointment on your account. I've asked ${op.contact.split(' ')[0]} to take a look.`);
        return wf;
      }
      throw e;
    }
    if (appt && appt.clientId !== client.id) appt = null;
    if (!appt) {
      this.send(wf, client.phone, `I don't see an appointment on ${intent.day ?? 'that day'}. Which one did you mean?`);
      wf.state = 'clarifying';
      return wf;
    }
    wf.data.appointmentId = appt.id;

    if (intent.intent === 'cancel') return this.cancelFlow(wf, api, client, appt);
    return this.rescheduleFlow(wf, api, client, appt, intent.newTime);
  }

  cancelFlow(wf, api, client, appt) {
    const d = decide('cancel_appointment', { now: this.now(), appointment: appt }, this.db.operators[wf.operatorId].authority);
    this.audit(wf, 'policy', `decision.${d.mode}`, d.reason);
    const helper = api.helper(appt.helperId);
    if (d.mode === 'auto') return this.doCancel(wf, api, client, appt, helper, 'agent');
    const summary = `${client.name} asked to cancel ${fmtWin(appt)} with ${helper.name}.`;
    if (d.mode === 'approve') {
      this.escalate(wf, d.reason, summary, 'Approve to cancel and notify both.', { action: 'cancel_appointment', appointmentId: appt.id });
    } else {
      this.escalate(wf, d.reason, summary, 'Call the client about the late-cancellation fee, then cancel.');
    }
    this.send(wf, client.phone, `Got it. ${this.db.operators[wf.operatorId].contact.split(' ')[0]} will confirm your cancellation shortly.`);
    return wf;
  }
  doCancel(wf, api, client, appt, helper, actor) {
    api.cancel(appt.id);
    this.calendar.remove(appt.id);
    this.audit(wf, actor, 'appointment.cancelled', appt.id);
    this.send(wf, client.phone, `Done - your ${fmtWin(appt)} appointment is cancelled.`);
    this.send(wf, helper.phone, `Heads up: ${client.name}'s ${fmtWin(appt)} appointment was cancelled.`);
    wf.state = 'done';
    return wf;
  }

  rescheduleFlow(wf, api, client, appt, newTime) {
    const date = this.resolveDay(newTime.day);
    const len = new Date(appt.end) - new Date(appt.start);
    const startHour = newTime.part === 'morning' ? '09' : newTime.part === 'afternoon' ? '13' : appt.start.slice(11, 13);
    const window = { start: `${date}T${startHour}:00:00Z` };
    window.end = new Date(new Date(window.start).getTime() + len).toISOString().replace('.000', '');
    wf.data.window = window;
    const d = decide('reschedule_appointment', { now: this.now(), window }, this.db.operators[wf.operatorId].authority);
    this.audit(wf, 'policy', `decision.${d.mode}`, d.reason);
    if (d.mode === 'escalate') {
      this.escalate(wf, d.reason, `${client.name} wants to move ${fmtWin(appt)} to ${fmtWin(window)}.`, 'Call the client.');
      return wf;
    }
    const helper = api.helper(appt.helperId);
    const avail = api.helperAvailability(helper.id, window);
    this.audit(wf, 'api', 'availability', `${helper.name} on ${fmtWin(window)}: ${avail}`);
    this.send(wf, client.phone, `Let me check with ${helper.name} about ${fmtWin(window)} and get right back to you.`);
    if (avail === 'busy') return this.findAlternate(wf, api, client, appt, [helper.id]);
    this.ask(wf, helper.phone, `Hi ${helper.name}, could you do ${client.name} on ${fmtWin(window)} instead of ${fmtWin(appt)}? Reply YES or NO.`, 'awaiting_helper');
    return wf;
  }

  findAlternate(wf, api, client, appt, exclude) {
    const [next] = api.eligibleHelpers(client.id, wf.data.window, exclude);
    wf.data.tried = exclude;
    if (!next) {
      this.escalate(wf, 'No eligible helper for the new time.', `${client.name} wants ${fmtWin(wf.data.window)}; tried ${exclude.length} helper(s).`, 'Offer the client other times.');
      this.send(wf, client.phone, `We're still working on ${fmtWin(wf.data.window)}. ${this.db.operators[wf.operatorId].contact.split(' ')[0]} will follow up with options.`);
      return wf;
    }
    this.audit(wf, 'api', 'match', `best match: ${next.name}${next.knowsClient ? ' (has worked with this client)' : ''}`);
    this.ask(wf, next.phone, `Hi ${next.name}, are you free for ${client.name} on ${fmtWin(wf.data.window)}? Reply YES or NO.`, 'awaiting_alternate', { candidate: next.id });
    return wf;
  }

  // ---------- helper messages ----------
  async startHelper(who, text, intent) {
    const wf = this.newWorkflow(intent.intent, who, text);
    const api = this.api(who.operatorId);
    const helper = api.helper(who.id);
    if (intent.intent !== 'callout') {
      this.escalate(wf, 'Helper message outside the automated flows.', `${helper.name} wrote: "${text}"`, 'Reply to the helper.');
      return wf;
    }
    const day = this.resolveDay(intent.day);
    const affected = api.appointmentsForHelper(helper.id, `${day}T00:00:00Z`, `${day}T23:59:59Z`);
    this.audit(wf, 'api', 'affected', `${affected.length} appointment(s) on ${day}`);
    this.send(wf, helper.phone, `Sorry to hear that, ${helper.name} - feel better. I'll find cover for your ${affected.length} appointment(s).`);
    wf.data = { queue: affected.map((a) => a.id), current: null, tried: [helper.id] };
    return this.nextCover(wf, api);
  }
  nextCover(wf, api) {
    if (!wf.data.current) {
      wf.data.current = wf.data.queue.shift() ?? null;
      wf.data.tried = [wf.sender.id];
      if (!wf.data.current) { wf.state = 'done'; this.audit(wf, 'agent', 'workflow.done', 'all appointments covered'); return wf; }
    }
    const appt = api.appointment(wf.data.current);
    const client = api.client(appt.clientId);
    const [next] = api.eligibleHelpers(client.id, appt, wf.data.tried);
    if (!next) {
      this.escalate(wf, 'No cover found.', `${client.name}, ${fmtWin(appt)}: tried ${wf.data.tried.length - 1} helper(s).`, 'Call the client to reschedule.');
      wf.data.current = null;
      return wf;
    }
    this.audit(wf, 'api', 'match', `${fmtWin(appt)} best match: ${next.name}${next.knowsClient ? ' (knows client)' : ''}`);
    this.ask(wf, next.phone, `Hi ${next.name}, can you cover ${client.name} on ${fmtWin(appt)}? Reply YES or NO.`, 'awaiting_cover', { candidate: next.id });
    return wf;
  }

  // ---------- resuming ----------
  async advance(wf, answer) {
    const api = this.api(wf.operatorId);
    if (wf.type === 'callout') {
      if (answer === 'yes') {
        const appt = api.reassign(wf.data.current, wf.candidate);
        const client = api.client(appt.clientId);
        const helper = api.helper(wf.candidate);
        this.calendar.update(appt.id, { helper: helper.name });
        this.audit(wf, 'agent', 'appointment.reassigned', `${appt.id} -> ${helper.name}`);
        this.send(wf, helper.phone, `Thank you! You're booked with ${client.name}, ${fmtWin(appt)}.`);
        this.send(wf, client.phone, `Hi ${client.name.split(' ')[0]}, ${api.helper(wf.sender.id).name} is out sick, so ${helper.name} will come on ${fmtWin(appt)} instead.`);
        wf.data.current = null;
      } else wf.data.tried.push(wf.candidate);
      return this.nextCover(wf, api);
    }

    const appt = api.appointment(wf.data.appointmentId);
    const client = api.client(appt.clientId);
    if (wf.state === 'awaiting_helper') {
      if (answer === 'yes') return this.applyReschedule(wf, api, client, appt, appt.helperId);
      return this.findAlternate(wf, api, client, appt, [appt.helperId]);
    }
    if (wf.state === 'awaiting_alternate') {
      if (answer === 'no') return this.findAlternate(wf, api, client, appt, [...wf.data.tried, wf.candidate]);
      const alt = api.helper(wf.candidate);
      this.ask(wf, client.phone, `${api.helper(appt.helperId).name} can't make ${fmtWin(wf.data.window)}, but ${alt.name} can. Is that okay? Reply YES or NO.`, 'awaiting_client_ok');
      return wf;
    }
    if (wf.state === 'awaiting_client_ok') {
      if (answer === 'yes') return this.applyReschedule(wf, api, client, appt, wf.candidate);
      this.escalate(wf, 'Client declined the alternate helper.', `${client.name} wants ${fmtWin(wf.data.window)} but not with the available helper.`, 'Offer other times with the usual helper.');
      return wf;
    }
    return wf;
  }

  applyReschedule(wf, api, client, appt, helperId) {
    const from = { start: appt.start, end: appt.end };
    api.reschedule(appt.id, wf.data.window);
    if (helperId !== appt.helperId) { api.reassign(appt.id, helperId); this.audit(wf, 'agent', 'appointment.reassigned', `${appt.id} -> ${api.helper(helperId).name}`); }
    this.calendar.update(appt.id, { ...wf.data.window, helper: api.helper(helperId).name });
    this.audit(wf, 'agent', 'appointment.rescheduled', `${appt.id}: ${fmtWin(from)} -> ${fmtWin(wf.data.window)}`);
    this.send(wf, client.phone, `All set! You're booked for ${fmtWin(wf.data.window)} with ${api.helper(helperId).name}.`);
    if (helperId !== appt.helperId) this.send(wf, api.helper(appt.helperId).phone, `No problem - ${client.name}'s ${fmtWin(from)} visit has moved to someone else.`);
    this.send(wf, api.helper(helperId).phone, `Confirmed: ${client.name}, ${fmtWin(wf.data.window)}.`);
    wf.state = 'done';
    return wf;
  }

  // ---------- timeouts: run every few minutes by a scheduler ----------
  async tick() {
    for (const [phone, ask] of Object.entries(this.store.asks)) {
      if (ask.expiresAt > this.now()) continue;
      this.clearAsk(phone);
      const wf = this.store.workflows[ask.workflowId];
      this.audit(wf, 'system', 'timeout', `no reply from ${phone} in ${HELPER_REPLY_MINUTES} min`);
      if (wf.state === 'awaiting_client_ok') { this.escalate(wf, 'Client did not reply.', `Waiting on ${phone}.`, 'Call the client.'); continue; }
      await this.advance(wf, 'no');
    }
  }

  // ---------- operator approves a prepared action ----------
  approve(escalationId, operatorId) {
    const esc = this.store.escalations.find((e) => e.id === escalationId);
    if (!esc || esc.operatorId !== operatorId) throw new Forbidden('Not your escalation');
    const wf = this.store.workflows[esc.workflowId];
    const api = this.api(operatorId);
    esc.status = 'approved';
    this.audit(wf, 'operator', 'approved', esc.proposed.action);
    const appt = api.appointment(esc.proposed.appointmentId);
    return this.doCancel(wf, api, api.client(appt.clientId), appt, api.helper(appt.helperId), 'operator');
  }
}
