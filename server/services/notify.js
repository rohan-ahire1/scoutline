// Operator alerts: nightly failed, nightly found nothing, a job ran out of
// attempts. Sent to Telegram when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are
// set; always logged. Never throws: an alert must not break the work that
// raised it.

const JOB_FAILURE_WINDOW_MS = 10 * 60_000

export function getNotifyConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim()
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim()
  return { telegram: Boolean(token && chatId), token, chatId }
}

export function createNotifier({ env = process.env, fetchImpl = globalThis.fetch, log = console.log, now = Date.now } = {}) {
  const config = getNotifyConfig(env)
  let windowStart = 0
  let suppressed = 0

  async function send(text) {
    log(`[notify] ${text}`)
    if (!config.telegram) return { sent: false, reason: 'telegram-not-configured' }
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, text: `Scoutline: ${text}`.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        log(`[notify] telegram answered ${res.status}`)
        return { sent: false, reason: `http-${res.status}` }
      }
      return { sent: true }
    } catch (error) {
      log(`[notify] telegram failed: ${error.message}`)
      return { sent: false, reason: 'network' }
    }
  }

  // A burst of failures (a provider outage, a bad deploy) sends one alert and
  // folds the rest into the next one instead of flooding the chat.
  async function jobFailed(job, detail) {
    const t = now()
    if (t - windowStart < JOB_FAILURE_WINDOW_MS) {
      suppressed += 1
      log(`[notify] suppressed job failure ${job.id} (${job.type})`)
      return { sent: false, reason: 'throttled' }
    }
    const extra = suppressed ? ` (+${suppressed} more since the last alert)` : ''
    windowStart = t
    suppressed = 0
    return send(`${job.type} job failed after ${job.attempts}/${job.maxAttempts} attempts${job.leadId ? ` for ${job.leadId}` : ''}: ${String(detail || 'unknown error').slice(0, 200)}${extra}`)
  }

  return { configured: config.telegram, send, jobFailed }
}
