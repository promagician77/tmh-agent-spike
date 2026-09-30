import { runScenarios } from '../src/scenarios.js';
const results = await runScenarios();
for (const r of results) {
  console.log(`\n=== ${r.title} ===`);
  for (const e of r.events) {
    const t = e.at.slice(11, 16);
    if (e.kind === 'in') console.log(`${t}  <- ${e.from}: ${e.text}`);
    else if (e.kind === 'out') console.log(`${t}  -> ${e.to}: ${e.text}`);
    else if (e.kind === 'escalation') console.log(`${t}  !! ${e.escType === 'approval' ? 'APPROVAL' : 'ESCALATE'}: ${e.reason} | ${e.recommended}`);
    else if (e.kind === 'system') console.log(`${t}  ** ${e.text}`);
    else if (e.action !== 'sms.sent') console.log(`${t}     [${e.actor}] ${e.action}: ${e.detail}`);
  }
  for (const c of r.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.label}`);
}
const all = results.flatMap((r) => r.checks);
console.log(`\n${all.filter((c) => c.pass).length}/${all.length} checks passed across ${results.length} scenarios`);
process.exit(all.every((c) => c.pass) ? 0 : 1);
