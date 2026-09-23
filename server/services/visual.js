// Visual review: what the site actually looks like. Markup checks cannot
// tell a tired 2014 template from a polished build, but a screenshot can.
// Captures desktop and mobile screenshots in headless Chrome, then asks a
// vision model to rate them on a fixed rubric. The screenshots are kept as
// evidence and double as the "before" image in outreach.
import OpenAI from 'openai'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPublicUrl } from './audit.js'
import { CHROME_SAFETY_FLAGS } from './crawlPolicy.js'

export const VISUAL_REVIEW_VERSION = 1

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const MAX_FULL_HEIGHT = 5000

export function getVisionConfig(options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) return { configured: false }
  return { configured: true, provider: 'openai', apiKey, model: options.model || process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini' }
}

// Captures above-the-fold and (capped) full-page screenshots per viewport.
// Returns { desktop: { fold, full }, mobile: { fold, full } } as JPEG buffers.
export async function captureScreenshots(input, options = {}) {
  const url = await assertPublicUrl(input)
  const [{ default: puppeteer }, chromeLauncher] = await Promise.all([import('puppeteer-core'), import('chrome-launcher')])
  const chrome = await chromeLauncher.launch({
    chromePath: options.chromePath || process.env.CHROME_PATH || undefined,
    chromeFlags: [...CHROME_SAFETY_FLAGS],
  })
  let browser
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()
    browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, defaultViewport: null })
    const shots = {}
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage()
      try {
        await page.setViewport(viewport)
        if (viewport.isMobile) await page.setUserAgent(MOBILE_UA)
        const response = await page.goto(url.href, { waitUntil: 'networkidle2', timeout: options.timeoutMs || 30_000 })
          .catch(async (error) => {
            // Chatty analytics can keep the network busy forever; a loaded DOM is enough.
            if (/timeout/i.test(error.message)) return null
            throw error
          })
        await new Promise((resolve) => setTimeout(resolve, 1200))
        // Nudge lazy-loaded sections into view, then return to the top.
        await page.evaluate(async (cap) => {
          for (let y = 0; y < Math.min(document.body.scrollHeight, cap); y += 700) {
            window.scrollTo(0, y)
            await new Promise((r) => setTimeout(r, 120))
          }
          window.scrollTo(0, 0)
        }, MAX_FULL_HEIGHT)
        await new Promise((resolve) => setTimeout(resolve, 400))
        const overlays = await clearOverlays(page)
        const fold = await page.screenshot({ type: 'jpeg', quality: 72 })
        const height = await page.evaluate(() => document.documentElement.scrollHeight)
        const full = await page.screenshot({
          type: 'jpeg', quality: 60,
          clip: { x: 0, y: 0, width: viewport.width, height: Math.min(height, MAX_FULL_HEIGHT) },
          captureBeyondViewport: true,
        })
        shots[name] = { fold, full, status: response?.status() ?? null, finalUrl: page.url(), pageHeight: height, overlays }
      } finally {
        await page.close().catch(() => {})
      }
    }
    return shots
  } finally {
    await browser?.disconnect().catch(() => {})
    await chrome.kill()
  }
}

// Popups and cookie banners hide the design. Click an obvious dismiss button
// first, then hide any fixed layer still covering a big part of the screen.
// Returns what was removed: a popup on page load is itself a finding.
async function clearOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {})
  return page.evaluate(() => {
    const removed = []
    const vw = window.innerWidth
    const vh = window.innerHeight
    const label = (el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    const isDialog = (el) => /dialog|modal|popup|overlay|lightbox|cookie|consent/i.test(`${el.getAttribute('role') || ''} ${el.className || ''} ${el.id || ''}`)
    const candidates = [...document.querySelectorAll('body *')].filter((el) => {
      const style = getComputedStyle(el)
      if (!['fixed', 'sticky'].includes(style.position) || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.1) return false
      // Site navigation (including off-canvas menus) is part of the design.
      if ((el.matches('header, nav') || el.querySelector('nav')) && !isDialog(el)) return false
      const r = el.getBoundingClientRect()
      const visibleW = Math.min(r.right, vw) - Math.max(r.left, 0)
      const visibleH = Math.min(r.bottom, vh) - Math.max(r.top, 0)
      return visibleW > 0 && visibleH > 0 && visibleW * visibleH > vw * vh * 0.18
    })
    const layers = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)))
    for (const layer of layers) {
      const text = label(layer)
      const kind = /cookie|consent|privacy|gdpr/i.test(text) ? 'cookie banner' : 'popup'
      const button = [...layer.querySelectorAll('button, a, [role="button"], .close, [aria-label]')]
        .find((b) => /^(×|x|✕|close|accept|accept all|agree|i agree|got it|ok|okay|no thanks|dismiss)$/i.test(label(b)) || /close|dismiss/i.test(b.getAttribute('aria-label') || '') || /close/i.test(String(b.className)))
      if (button) button.click()
      layer.style.setProperty('display', 'none', 'important')
      removed.push({ kind, text: text.slice(0, 60) })
    }
    document.documentElement.style.overflow = 'auto'
    document.body.style.overflow = 'auto'
    return removed
  }).catch(() => [])
}

export function saveScreenshots(dir, shots) {
  mkdirSync(dir, { recursive: true })
  const files = {}
  for (const [name, shot] of Object.entries(shots)) {
    for (const kind of ['fold', 'full']) {
      const file = `${name}-${kind}.jpg`
      writeFileSync(join(dir, file), shot[kind])
      files[`${name}${kind === 'fold' ? '' : 'Full'}`] = file
    }
  }
  return files
}

const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['looksDated', 'visualPolish', 'mobileExperience', 'clarity', 'trust', 'eraGuess', 'verdict', 'issues', 'strengths', 'summary'],
  properties: {
    looksDated: { type: 'integer', minimum: 1, maximum: 5, description: '1 = looks current, 5 = looks 10+ years old' },
    visualPolish: { type: 'integer', minimum: 1, maximum: 5, description: '1 = amateur or broken, 5 = professionally designed' },
    mobileExperience: { type: 'integer', minimum: 1, maximum: 5, description: '1 = unusable on a phone, 5 = excellent' },
    clarity: { type: 'integer', minimum: 1, maximum: 5, description: 'Can a visitor tell in 5 seconds what they do, where, and how to get a quote? 1 = no, 5 = instantly' },
    trust: { type: 'integer', minimum: 1, maximum: 5, description: 'Real photos, reviews, credentials visible. 1 = none, 5 = strong' },
    eraGuess: { type: 'string', description: 'The design era it resembles, e.g. "2012 WordPress theme"' },
    verdict: { type: 'string', enum: ['redesign', 'improve', 'leave'] },
    issues: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false, required: ['view', 'issue'],
        properties: { view: { type: 'string', enum: ['desktop', 'mobile', 'both'] }, issue: { type: 'string' } },
      },
    },
    strengths: { type: 'array', maxItems: 3, items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const REVIEW_PROMPT = `You are a senior web designer at a small studio that redesigns websites for local trade businesses (HVAC, electricians, roofers, flooring, landscaping).
Review the screenshots of this business's website: desktop above the fold, desktop full page, mobile above the fold, mobile full page.

Judge only what is visible. Be strict and specific: a generic but tidy template is "improve", not "leave".
- verdict "redesign": looks dated, amateur, broken or hard to use; a new site would be an obvious upgrade.
- verdict "improve": decent base with clear, fixable problems.
- verdict "leave": modern and professional; we could not credibly pitch it.

Write each issue as one plain-English sentence a business owner would understand and agree with on sight. Name the exact element ("the header phone number is tiny and grey", "the hero is a blurry stock photo of a handshake"). No jargon, no SEO or code talk, and no claims about revenue or conversions.`

function overlayNote(shots) {
  const found = Object.entries(shots).flatMap(([view, shot]) => (shot.overlays || []).filter((o) => o.kind === 'popup').map((o) => `${view}: "${o.text}"`))
  return found.length ? `\nPopups that covered the page on load (removed before the screenshots): ${found.join('; ')}.` : ''
}

export function weaknessFromReview(review) {
  // Map the 1-5 rubric onto 0-100 "how weak": dated counts up, the rest count down.
  const inv = (v) => (5 - v) / 4
  const raw = ((review.looksDated - 1) / 4) * 0.3 + inv(review.visualPolish) * 0.25 + inv(review.mobileExperience) * 0.2 + inv(review.clarity) * 0.15 + inv(review.trust) * 0.1
  const verdictFloor = review.verdict === 'redesign' ? 60 : review.verdict === 'improve' ? 25 : 0
  const verdictCap = review.verdict === 'leave' ? 30 : review.verdict === 'improve' ? 70 : 100
  return Math.round(Math.min(verdictCap, Math.max(verdictFloor, raw * 100)))
}

export async function reviewScreenshots(shots, { company = '', category = '', website = '' } = {}, options = {}) {
  const config = getVisionConfig(options)
  if (!config.configured) throw new Error('Visual review needs OPENAI_API_KEY')
  const client = options.client || new OpenAI({ apiKey: config.apiKey, timeout: 90_000, maxRetries: 2 })
  const image = (buffer) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${buffer.toString('base64')}`, detail: 'high' })
  const response = await client.responses.create({
    model: config.model,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `${REVIEW_PROMPT}\n\nBusiness: ${company} (${category}). Website: ${website}.${overlayNote(shots)}` },
        image(shots.desktop.fold), image(shots.desktop.full), image(shots.mobile.fold), image(shots.mobile.full),
      ],
    }],
    text: { format: { type: 'json_schema', name: 'scoutline_visual_review', strict: true, schema: reviewSchema } },
  })
  const review = JSON.parse(response.output_text)
  return {
    version: VISUAL_REVIEW_VERSION,
    reviewedAt: new Date().toISOString(),
    provider: config.provider,
    model: config.model,
    ...review,
    score: weaknessFromReview(review),
    issues: review.issues.map((item) => `${item.issue}${item.view === 'both' ? '' : ` (${item.view})`}`),
  }
}
