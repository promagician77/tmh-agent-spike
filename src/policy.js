// Authority levels. The model never decides these; this code does.
//   auto      - do it, then tell people
//   approve   - prepare it, an operator clicks approve
//   escalate  - hand to an operator with a summary and a recommendation
// Operators can move an action from 'approve' to 'auto' as trust builds.

export const DEFAULT_AUTHORITY = {
  cancel_appointment: 'auto',
  reschedule_appointment: 'auto',     // still needs the helper's yes first
  reassign_helper: 'auto',            // still needs the new helper's yes first
  change_recurring_series: 'approve',
  refund: 'escalate',
  pricing: 'escalate',
  complaint: 'escalate',
};

export const MIN_CONFIDENCE = 0.75;
export const HELPER_REPLY_MINUTES = 60;

const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 36e5;

export function decide(action, ctx, operatorAuthority = {}) {
  const level = operatorAuthority[action] ?? DEFAULT_AUTHORITY[action] ?? 'escalate';
  if (level === 'escalate') return { mode: 'escalate', reason: `"${action}" is always handled by a person.` };

  if (action === 'cancel_appointment') {
    const h = hoursBetween(ctx.now, ctx.appointment.start);
    if (h < 24) return { mode: 'escalate', reason: `Late cancellation (${Math.round(h)}h before start). A fee may apply, so a person should decide.` };
  }
  if (action === 'reschedule_appointment') {
    const h = hoursBetween(ctx.now, ctx.window.start);
    if (h < 12) return { mode: 'escalate', reason: `New time is only ${Math.round(h)}h away. Too tight to coordinate automatically.` };
  }
  return level === 'approve'
    ? { mode: 'approve', reason: `This operator approves "${action}" before it runs.` }
    : { mode: 'auto', reason: 'Within approved rules.' };
}
