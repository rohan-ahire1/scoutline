// Regenerates the committed benchmark reports: `node server/benchmark/run.js`.
// Writes eval-report.json + eval-report.md next to the fixtures. Offline only.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEval, writeEvalReports } from './eval.js'
import { checkGates, gatesPass } from './gates.js'

const dir = dirname(fileURLToPath(import.meta.url))
const report = await runEval(join(dir, 'fixtures.v1.json'))
const gates = checkGates(report)
const files = writeEvalReports({ ...report, gates }, dir)
console.log(`eval ${report.totals.passed}/${report.totals.ran} checks passed across ${report.fixtureCases} fixtures`)
for (const gate of gates) console.log(`gate ${gate.pass ? 'PASS' : 'FAIL'} ${gate.id} — ${gate.detail}`)
if (!gatesPass(gates)) process.exitCode = 1
console.log(`wrote ${files.join(', ')}`)
