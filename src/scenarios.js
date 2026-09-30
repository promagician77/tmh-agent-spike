import { Engine, emptyStore } from './engine.js';
import { fixture, NOW } from './fixture.js';
import { ruleInterpreter } from './interpret.js';

function harness({ store } = {}) {
  let t = NOW;
  const clock = { now: () => t, advance: (min) => { t = new Date(new Date(t).getTime() + min * 6e4).toISOString().replace('.000', ''); } };
  const sms = { sent: [], send(to, text) { this.sent.push({ to, text }); } };
  const calendar = { ops: [], remove(id) { this.ops.push(['remove', id]); }, update(id, p) { this.ops.push(['update', id, p]); } };
  const events = [];
  const db = fixture();
  const make = (s) => new Engine({ db, store: s, clock, interpreter: ruleInterpreter, sms, calendar, onEvent: (e) => events.push({ at: clock.now(), ...e }) });
  let engine = make(store ?? emptyStore());
  let n = 0;
  const say = (from, text, messageId = `m${++n}`) => engine.handleInbound({ messageId, from, text });
  // Simulates a deploy/crash: only the saved JSON survives.
  const restart = () => { const saved = JSON.stringify(engine.store); engine = make(JSON.parse(saved)); events.push({ at: clock.now(), kind: 'system', text: 'Server restarted. Workflow state reloaded from the database.' }); };
  return { db, clock, sms, calendar, events, say, restart, get engine() { return engine; } };
}

const P = { sarah: '+15125550101', tom: '+15125550102', lena: '+15125550103', priya: '+17205550101',
  maria: '+15125550201', jen: '+15125550202', ana: '+15125550203', bea: '+15125550204' };
export const PHONES = P;

export const SCENARIOS = [
  {
    id: 'cancel', title: 'Cancel with notice', summary: 'Within the rules, so the agent just does it.',
    async run(h) {
      await h.say(P.sarah, 'Please cancel Thursday');
      return [['Appointment cancelled', h.db.appointments.apt_a1.status === 'cancelled'], ['Client and helper both told', h.sms.sent.length === 2], ['Calendar updated', h.calendar.ops[0]?.[0] === 'remove']];
    },
  },
  {
    id: 'late-cancel', title: 'Late cancellation', summary: 'Under 24 hours, a fee may apply, so a person decides.',
    async run(h) {
      await h.say(P.tom, 'Need to cancel today, sorry');
      const esc = h.engine.store.escalations[0];
      return [['Not cancelled automatically', h.db.appointments.apt_a4.status === 'booked'], ['Escalated with a recommendation', esc?.recommended?.includes('fee')]];
    },
  },
  {
    id: 'reschedule', title: 'Reschedule, helper says yes', summary: 'Asks the helper, survives a restart while waiting, then confirms everyone.',
    async run(h) {
      await h.say(P.sarah, 'Can we move Thursday to Friday morning?');
      const waiting = h.engine.store.workflows.wf_1?.state === 'awaiting_helper';
      h.restart();
      h.clock.advance(22);
      await h.say(P.maria, 'Yes that works');
      const a = h.db.appointments.apt_a1;
      return [['Waited for the helper', waiting], ['Resumed after a restart', h.engine.store.workflows.wf_1.state === 'done'], ['Moved to Friday 9-12', a.start === '2026-10-09T09:00:00Z' && a.end === '2026-10-09T12:00:00Z'], ['Same helper kept', a.helperId === 'h_maria']];
    },
  },
  {
    id: 'alternate', title: 'Helper says no, alternate found', summary: 'Finds the best other helper, checks with them, then asks the client before changing anything.',
    async run(h) {
      await h.say(P.sarah, 'Can we move Thursday to Friday morning?');
      await h.say(P.maria, 'No sorry, I have class');
      await h.say(P.jen, 'Yes I can');
      await h.say(P.sarah, 'Yes, Jen is great');
      const a = h.db.appointments.apt_a1;
      return [['Picked Jen (has worked with Sarah)', a.helperId === 'h_jen'], ['Client agreed before the change', h.sms.sent.some((m) => m.to === P.sarah && m.text.includes('Is that okay'))], ['Rescheduled to Friday', a.start.startsWith('2026-10-09')]];
    },
  },
  {
    id: 'callout', title: 'Helper calls in sick', summary: 'Covers two appointments. One helper never replies, so it moves on after the timeout.',
    async run(h) {
      await h.say(P.maria, "I'm sick and can't make it tomorrow");
      h.clock.advance(61);
      await h.engine.tick();
      await h.say(P.jen, 'Yes');
      await h.say(P.bea, 'Sure');
      const { apt_a2: a2, apt_a3: a3 } = h.db.appointments;
      return [['Ana timed out, moved to Jen', h.engine.store.audit.some((e) => e.action === 'timeout') && a2.helperId === 'h_jen'], ['Second appointment covered by Bea', a3.helperId === 'h_bea'], ['Both clients told', h.sms.sent.filter((m) => [P.tom, P.lena].includes(m.to)).length === 2]];
    },
  },
  {
    id: 'duplicate', title: 'Same webhook delivered twice', summary: 'SMS providers retry. The second copy must do nothing.',
    async run(h) {
      await h.say(P.sarah, 'Please cancel Thursday', 'quo_msg_123');
      const r = await h.say(P.sarah, 'Please cancel Thursday', 'quo_msg_123');
      return [['Second delivery ignored', r.duplicate === true], ['Only one set of messages sent', h.sms.sent.length === 2]];
    },
  },
  {
    id: 'isolation', title: "Another operator's appointment", summary: "A message names a Denver appointment id. The API refuses, whatever the model says.",
    async run(h) {
      await h.say(P.sarah, 'Please cancel apt_d1');
      return [['API returned 403', h.engine.store.audit.some((e) => e.action === 'blocked' && e.detail.startsWith('403'))], ['Denver appointment untouched', h.db.appointments.apt_d1.status === 'booked'], ['Flagged to the operator', h.engine.store.escalations.length === 1]];
    },
  },
  {
    id: 'refund', title: 'Refund request', summary: 'Payments are always a person. The agent only acknowledges and hands off.',
    async run(h) {
      await h.say(P.tom, 'I was charged twice last week, can I get a refund?');
      return [['Escalated', h.engine.store.escalations[0]?.reason.startsWith('Payment')], ['Client acknowledged', h.sms.sent.length === 1]];
    },
  },
  {
    id: 'ambiguous', title: 'Unclear request', summary: "Low confidence, so it asks instead of guessing.",
    async run(h) {
      await h.say(P.lena, 'Can we change things up next week?');
      return [['Asked a clarifying question', h.sms.sent[0]?.text.includes('Which appointment')], ['Nothing changed', Object.values(h.db.appointments).every((a) => a.status === 'booked')]];
    },
  },
  {
    id: 'approval', title: 'Operator still approves cancellations', summary: 'Denver hasn\'t made cancellations autonomous yet. The agent prepares it; a click runs it.',
    async run(h) {
      await h.say(P.priya, 'Please cancel Wednesday');
      const esc = h.engine.store.escalations[0];
      const before = h.db.appointments.apt_d1.status;
      let austinBlocked = false;
      try { h.engine.approve(esc.id, 'op_austin'); } catch { austinBlocked = true; }
      h.clock.advance(15);
      h.engine.approve(esc.id, 'op_denver');
      return [['Prepared, not executed', esc.kind === 'approval' && before === 'booked'], ['Austin cannot approve Denver\'s', austinBlocked], ['Executed after approval', h.db.appointments.apt_d1.status === 'cancelled']];
    },
  },
];

export async function runScenarios() {
  const out = [];
  for (const s of SCENARIOS) {
    const h = harness();
    let checks;
    try { checks = (await s.run(h)).map(([label, pass]) => ({ label, pass: !!pass })); }
    catch (e) { checks = [{ label: `Crashed: ${e.message}`, pass: false }]; }
    out.push({ id: s.id, title: s.title, summary: s.summary, checks, events: h.events, escalations: h.engine.store.escalations });
  }
  return out;
}
