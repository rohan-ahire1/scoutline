// Minimal client for TypeSafe's Jev "System One" API (plain REST, no SDK).
// Docs: https://docs.typesafe.ai/introduction/quickstart
// One call takes a text `state` plus typed questions and returns bounded
// probabilistic answers (noul / choice / score). Jev cannot write text, so it
// is used only to answer questions about evidence we already have.

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'
export const DEFAULT_PASS_THRESHOLD = 0.8

function parseThreshold(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : DEFAULT_PASS_THRESHOLD
}

// Configured only when a key is present. `options.jev === false` turns the
// gate off (tests, manual reruns).
export function getJevConfig(options = {}) {
  const apiKey = options.jev === false ? null : (options.jevApiKey ?? process.env.TYPESAFE_API_KEY ?? null)
  return {
    configured: Boolean(apiKey),
    apiKey: apiKey || null,
    model: options.jevModel || process.env.JEV_MODEL || DEFAULT_JEV_MODEL,
    passThreshold: parseThreshold(options.jevPassThreshold ?? process.env.JEV_PASS_THRESHOLD),
  }
}

export async function askJev({ apiKey, model = DEFAULT_JEV_MODEL, state, questions, signal, fetchImpl = fetch }) {
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model, questions }),
  }
  if (signal) init.signal = signal
  const res = await fetchImpl(JEV_ENDPOINT, init)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Jev API ${res.status}: ${text.slice(0, 500)}`)
  }
  return res.json()
}

export function asChoice(answer, name) {
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string' || !answer.probabilities || typeof answer.probabilities !== 'object') {
    throw new Error(`Jev answer ${JSON.stringify(name)} is not a choice answer`)
  }
  return answer
}
