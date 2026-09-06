// Fixture release gates (ROH-26). Each gate reads the eval report and returns
// a pass/fail with evidence — never just a green exit status.
export const GATE_DEFINITIONS = [
  {
    id: 'no-unsupported-attribution',
    description: 'Zero unsupported measurement attribution: every reported problem must cite measured evidence',
    check: (report) => {
      const failures = report.cases.filter((item) => !item.pass && ['analyzeHtml', 'museGrounding'].includes(item.runner))
      return failures.length
        ? { pass: false, detail: `${failures.length} unsupported-attribution failure(s): ${failures.map((item) => item.id).join(', ')}` }
        : { pass: true, detail: 'all analyzed/grounded checks cite measured evidence' }
    },
  },
  {
    id: 'no-timeout-as-broken',
    description: 'Zero timeout-as-broken assertions: timeouts and HTTP errors are reported as unreachable, never as broken sites',
    check: (report) => {
      const failures = report.cases.filter((item) => !item.pass && item.runner === 'fetchBehavior')
      const brokenFrames = report.cases.filter((item) => item.pass && item.runner === 'fetchBehavior' && /broken/i.test(item.detail))
      if (failures.length || brokenFrames.length) {
        return { pass: false, detail: `timeout/fetch failures: ${failures.map((item) => item.id).join(', ') || 'none'}; broken-framed: ${brokenFrames.map((item) => item.id).join(', ') || 'none'}` }
      }
      return { pass: true, detail: 'all fetch failures carry precise codes without broken-site framing' }
    },
  },
  {
    id: 'no-invented-filler',
    description: 'Zero invented filler findings: empty evidence yields the explicit no-opportunity outcome, never a generic opportunity',
    check: (report) => {
      const failures = report.cases.filter((item) => !item.pass && ['museGrounding', 'outreachGrounding'].includes(item.runner))
      return failures.length
        ? { pass: false, detail: `${failures.length} grounding failure(s): ${failures.map((item) => item.id).join(', ')}` }
        : { pass: true, detail: 'grounding checks reject invented claims and accept the explicit empty outcome' }
    },
  },
  {
    id: 'critical-paths-green',
    description: 'All critical persistence/cancellation-adjacent paths pass: capture classification, dedupe accounting, mapping',
    check: (report) => {
      const critical = ['classifyCapture', 'discoveryMapping', 'discoveryDedupe']
      const failures = report.cases.filter((item) => !item.pass && critical.includes(item.runner))
      return failures.length
        ? { pass: false, detail: `${failures.length} critical-path failure(s): ${failures.map((item) => `${item.id}/${item.runner}`).join(', ')}` }
        : { pass: true, detail: 'capture, mapping, and dedupe checks all pass' }
    },
  },
]

export function checkGates(report) {
  return GATE_DEFINITIONS.map((gate) => {
    try {
      const result = gate.check(report)
      return { id: gate.id, description: gate.description, pass: Boolean(result.pass), detail: result.detail || '' }
    } catch (error) {
      return { id: gate.id, description: gate.description, pass: false, detail: `gate crashed: ${error.message}` }
    }
  })
}

export function gatesPass(gateResults) {
  return gateResults.length > 0 && gateResults.every((gate) => gate.pass)
}
