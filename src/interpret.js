// Turns a message into a structured intent. The engine only ever sees this shape,
// so swapping the rule-based stand-in for the model changes nothing else.
//
// { intent, confidence, day, newTime, appointmentId, answer }
//   intent: cancel | reschedule | refund | complaint | callout | availability | answer | other
//   answer: yes | no (replies to a question the agent asked)

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const INTENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'confidence', 'day', 'newTime', 'appointmentId', 'answer'],
  properties: {
    intent: { type: 'string', enum: ['cancel', 'reschedule', 'refund', 'complaint', 'callout', 'availability', 'answer', 'other'] },
    confidence: { type: 'number' },
    day: { type: ['string', 'null'], description: 'today, tomorrow, or a weekday name for the appointment referred to' },
    newTime: { type: ['object', 'null'], additionalProperties: false, required: ['day', 'part'],
      properties: { day: { type: 'string' }, part: { type: 'string', enum: ['morning', 'afternoon', 'same'] } } },
    appointmentId: { type: ['string', 'null'] },
    answer: { type: ['string', 'null'], enum: ['yes', 'no', null] },
  },
};

// Deterministic stand-in so the spike runs and tests without an API key.
export const ruleInterpreter = {
  name: 'rules (offline stand-in)',
  async interpret({ text }) {
    const t = text.toLowerCase();
    const base = { intent: 'other', confidence: 0.4, day: null, newTime: null, appointmentId: null, answer: null };
    const dayIn = (s) => (s.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/) || [])[1] ?? null;
    if (/^\s*(yes|yeah|yep|sure|ok|okay|i can|can do|works)\b/.test(t)) return { ...base, intent: 'answer', answer: 'yes', confidence: 0.95 };
    if (/^\s*(no|nope|sorry|can'?t|cannot|not able)\b/.test(t)) return { ...base, intent: 'answer', answer: 'no', confidence: 0.95 };
    if (/refund|charged|money back|overcharg/.test(t)) return { ...base, intent: 'refund', confidence: 0.95 };
    if (/complain|unhappy|disappointed|terrible|upset/.test(t)) return { ...base, intent: 'complaint', confidence: 0.9 };
    if (/sick|can'?t make|not feeling well|emergency/.test(t)) return { ...base, intent: 'callout', day: dayIn(t) ?? 'tomorrow', confidence: 0.9 };
    const id = (t.match(/\b(apt_[a-z0-9]+)\b/) || [])[1] ?? null;
    if (/\bcancel\b/.test(t)) return { ...base, intent: 'cancel', day: dayIn(t), appointmentId: id, confidence: id || dayIn(t) ? 0.92 : 0.5 };
    const move = t.match(/\b(move|reschedule|switch|change)\b.*?\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*?\bto\b.*?\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s+(morning|afternoon))?/);
    if (move) return { ...base, intent: 'reschedule', day: move[2], newTime: { day: move[3], part: move[4] ?? 'same' }, confidence: 0.9 };
    return base;
  },
};

// Production path: OpenAI Responses API with a strict JSON schema, so the model
// can only return this shape. Not exercised by the tests (no key in CI).
export function openAIInterpreter({ apiKey, model = 'gpt-5-mini', fetchImpl = fetch } = {}) {
  return {
    name: `openai:${model}`,
    async interpret({ text, role, context }) {
      const res = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [
            { role: 'system', content: `You classify SMS/email from a ${role} of a household-help service. Only extract; never decide or promise anything. Today is ${context?.today}. If the sender answers a question, set intent "answer". If unsure, lower confidence.` },
            { role: 'user', content: text },
          ],
          text: { format: { type: 'json_schema', name: 'intent', schema: INTENT_SCHEMA, strict: true } },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}`);
      const data = await res.json();
      const out = data.output_text ?? data.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text;
      return JSON.parse(out);
    },
  };
}

export { DAYS };
