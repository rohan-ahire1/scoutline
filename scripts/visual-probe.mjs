// Screenshot + visual review for one URL, printing the verdict (no database).
// Usage: node scripts/visual-probe.mjs https://example.com [out-dir]
// Keys come from the environment, e.g. via `bws run ... -- node scripts/visual-probe.mjs <url>`.
import 'dotenv/config'
import { captureScreenshots, getVisionConfig, reviewScreenshots, saveScreenshots } from '../server/services/visual.js'

const [url, outDir = 'data/visual-probe'] = process.argv.slice(2)
if (!url) {
  console.error('Usage: node scripts/visual-probe.mjs <url> [out-dir]')
  process.exit(1)
}
const config = getVisionConfig()
console.log(`provider: ${config.configured ? `${config.provider} / ${config.model}` : 'none (screenshots only)'}`)
const shots = await captureScreenshots(url)
const files = saveScreenshots(outDir, shots)
console.log(`screenshots: ${Object.values(files).map((f) => `${outDir}/${f}`).join(', ')}`)
if (config.configured) {
  const review = await reviewScreenshots(shots, { website: url })
  console.log(JSON.stringify({ verdict: review.verdict, weakness: review.score, era: review.eraGuess, issues: review.issues, strengths: review.strengths, summary: review.summary }, null, 2))
}
