// Stand-in for the TMH PHP API. The point is WHERE the check lives:
// every call is scoped to the operator in the auth token, and the API itself
// refuses anything outside it. The agent never gets a key that can see more.

export class Forbidden extends Error { constructor(m) { super(m); this.status = 403; } }
export class NotFound extends Error { constructor(m) { super(m); this.status = 404; } }

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

export class TmhApi {
  constructor(db, operatorId) { this.db = db; this.op = operatorId; }

  #own(kind, id) {
    const row = this.db[kind][id];
    if (!row) throw new NotFound(`${kind} ${id} not found`);
    if (row.operatorId !== this.op) throw new Forbidden(`${kind} ${id} belongs to another operator`);
    return row;
  }
  client(id) { return { id, ...this.#own('clients', id) }; }
  helper(id) { return { id, ...this.#own('helpers', id) }; }
  appointment(id) { return { id, ...this.#own('appointments', id) }; }

  upcomingForClient(clientId, from) {
    this.#own('clients', clientId);
    return Object.entries(this.db.appointments)
      .filter(([, a]) => a.operatorId === this.op && a.clientId === clientId && a.status === 'booked' && a.start >= from)
      .map(([id, a]) => ({ id, ...a })).sort((x, y) => x.start.localeCompare(y.start));
  }
  appointmentsForHelper(helperId, from, to) {
    this.#own('helpers', helperId);
    return Object.entries(this.db.appointments)
      .filter(([, a]) => a.operatorId === this.op && a.helperId === helperId && a.status === 'booked' && a.start >= from && a.start < to)
      .map(([id, a]) => ({ id, ...a }));
  }
  // 'busy' if booked, otherwise 'unknown': TMH rarely knows free time for sure,
  // so the agent has to ask. Known open windows would return 'free'.
  helperAvailability(helperId, window) {
    this.#own('helpers', helperId);
    const busy = Object.values(this.db.appointments).some((a) => a.helperId === helperId && a.status === 'booked' && overlaps(a, window));
    return busy ? 'busy' : 'unknown';
  }
  // Eligible = same operator, right skills, not already booked, not excluded.
  // Ranked: has worked with this client before, then fewest booked hours this week.
  eligibleHelpers(clientId, window, exclude = []) {
    const client = this.#own('clients', clientId);
    const hours = (hid) => Object.values(this.db.appointments)
      .filter((a) => a.helperId === hid && a.status === 'booked').reduce((s, a) => s + (new Date(a.end) - new Date(a.start)) / 36e5, 0);
    return Object.entries(this.db.helpers)
      .filter(([id, h]) => h.operatorId === this.op && !exclude.includes(id)
        && client.needs.every((n) => h.skills.includes(n)) && this.helperAvailability(id, window) !== 'busy')
      .map(([id, h]) => ({ id, ...h, knowsClient: client.history.includes(id), hours: hours(id) }))
      .sort((a, b) => (b.knowsClient - a.knowsClient) || (a.hours - b.hours));
  }

  cancel(id) { const a = this.#own('appointments', id); a.status = 'cancelled'; return { id, ...a }; }
  reschedule(id, window) { const a = this.#own('appointments', id); a.start = window.start; a.end = window.end; return { id, ...a }; }
  reassign(id, helperId) { const a = this.#own('appointments', id); this.#own('helpers', helperId); a.helperId = helperId; return { id, ...a }; }
}

// Maps an inbound phone number to who it is. Returns ids only; all data access
// after this goes through a TmhApi scoped to that operator.
export function directory(db) {
  const map = new Map();
  for (const [id, c] of Object.entries(db.clients)) map.set(c.phone, { kind: 'client', id, operatorId: c.operatorId });
  for (const [id, h] of Object.entries(db.helpers)) map.set(h.phone, { kind: 'helper', id, operatorId: h.operatorId });
  return (phone) => map.get(phone) ?? null;
}
