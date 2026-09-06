// Fake providers for the ROH-26 offline quality benchmark. Nothing here touches
// the network beyond loopback, spends money, or needs credentials.
//
// - createFakeFetch: scripted global-fetch replacement with a call ledger.
// - startFakeModelServer: loopback HTTP server speaking enough of the OpenAI
//   chat-completions API for the real SDK (used by generateMuseAnalysis via
//   the `meta` provider options.baseURL seam). Script the first N responses,
//   then fall through to `defaultResponse`.
import { createServer } from 'node:http'

export function createFakeFetch(routes = {}, { ledger = [] } = {}) {
  const queues = new Map(Object.entries(routes).map(([url, steps]) => [url, [...(Array.isArray(steps) ? steps : [steps])]]))
  const fake = async (url, options = {}) => {
    const key = String(url)
    ledger.push({ url: key, method: options.method || 'GET', at: new Date().toISOString() })
    // Exact URL matches win; '*' is an ordered journey fallback (redirect
    // chains) consumed step by step regardless of URL.
    const queue = (queues.get(key)?.length ? queues.get(key) : queues.get('*'))
    if (!queue || !queue.length) throw new Error(`FakeFetch: no scripted response for ${key} — this test must not reach the real network`)
    const step = queue.shift()
    if (step.networkError) {
      const error = new Error(step.networkError)
      error.name = step.errorName || 'TypeError'
      throw error
    }
    if (step.hang) {
      // A hanging socket ends the way a real undici timeout ends: the timeout
      // signal fires and fetch rejects with TimeoutError. Explicit user
      // cancellation is tested with pre-aborted signals, never with hangs.
      await new Promise((resolve, reject) => {
        const fire = () => {
          const error = new Error('FakeFetch: the operation timed out')
          error.name = 'TimeoutError'
          reject(error)
        }
        if (options.signal?.aborted) { fire(); return }
        options.signal?.addEventListener('abort', fire)
      })
      throw new Error('FakeFetch: hang resolved unexpectedly')
    }
    if (step.timeoutError) {
      const error = new Error('FakeFetch: timed out')
      error.name = 'TimeoutError'
      throw error
    }
    return new Response(step.body ?? '', { status: step.status ?? 200, headers: step.headers ?? {} })
  }
  fake.ledger = ledger
  fake.callsTo = (match) => ledger.filter((entry) => entry.url.includes(match))
  return fake
}

export function withFakeFetch(fake, run) {
  const real = globalThis.fetch
  globalThis.fetch = fake
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = real })
}

function chatCompletionsPayload(content) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 0,
    model: 'fake-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }
}

// Scripted model responses: each entry is { status?, body? } where body is the
// assistant content string (or raw string when rawBody is set). Returns the
// server plus a request ledger.
export async function startFakeModelServer(script = [], { defaultResponse = null } = {}) {
  const ledger = []
  const queue = [...script]
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      ledger.push({ path: req.url, method: req.method, at: new Date().toISOString() })
      const step = queue.length ? queue.shift() : (defaultResponse || { body: JSON.stringify({ summary: 'ok', qualificationRecommendation: 'Pass', noSupportedOpportunity: true, topOpportunities: [] }) })
      const status = step.status ?? 200
      const payload = step.rawBody !== undefined ? step.rawBody : JSON.stringify(chatCompletionsPayload(step.body ?? ''))
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(payload)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    ledger,
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}
