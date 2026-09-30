# tmh-agent-spike

A small working spike of an AI scheduling agent that takes controlled actions:
interpret a request, decide within rules, call the API, message a helper, wait,
resume later, and escalate to an operator when it should.

```bash
npm test          # 10 scenarios + policy tests (Node 20+, no dependencies)
npm run scenarios # prints every conversation and audit line
npm start         # the notes page; scenarios run in the browser
```

| File | Role |
|---|---|
| `src/engine.js` | Orchestrator. All state lives in a JSON store (a DB table in production). |
| `src/policy.js` | Authority table: auto / approve / escalate, per operator. |
| `src/tmh-api.js` | Stand-in for the TMH API. Every call is scoped to one operator; others get 403. |
| `src/interpret.js` | Model interface. Offline rules for tests; OpenAI structured outputs for real use (`OPENAI_API_KEY`, `OPENAI_MODEL`). |
| `src/scenarios.js` | The ten scenarios used by tests and the page. |
| `src/fixture.js` | Made-up operators, clients, helpers, appointments. |

Key behaviours:
- Waiting is a saved row with a deadline; `engine.tick()` handles timeouts. Survives restarts.
- Inbound messages are de-duplicated by provider message id.
- The model only returns a fixed schema; it never chooses what's allowed.
- Operators can move an action from `approve` to `auto` in their authority settings.

Deploy: `npm run deploy`, or import in Vercel with the "Other" preset and no build command.
