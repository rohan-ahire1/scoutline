import { writeFile } from 'node:fs/promises';
import { pool } from './db.js';
import { config } from './config.js';

// Versioned snapshot consumed by the Scoutline "Crawl" tab. Bump when the
// shape changes so the importer can reject files it does not understand.
export const CRAWL_EXPORT_VERSION = 1;

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

async function getSummary() {
  const [today, states, quals, database] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(DISTINCT target_id) FILTER (WHERE created_at >= CURRENT_DATE)::int AS scheduled_today,
        COUNT(DISTINCT target_id) FILTER (WHERE created_at >= CURRENT_DATE AND status='done')::int AS completed_today,
        COUNT(DISTINCT target_id) FILTER (WHERE created_at >= CURRENT_DATE AND status='failed')::int AS failed_today
      FROM crawl_jobs
    `),
    pool.query(`SELECT crawl_state, COUNT(*)::int AS count FROM crawl_targets GROUP BY crawl_state`),
    pool.query(`SELECT qualification_state, COUNT(*)::int AS count FROM crawl_targets GROUP BY qualification_state`),
    pool.query(`SELECT pg_database_size(current_database())::bigint AS bytes`)
  ]);

  const stateCounts = Object.fromEntries(states.rows.map(r => [r.crawl_state, r.count]));
  const qualificationCounts = Object.fromEntries(quals.rows.map(r => [r.qualification_state, r.count]));
  const completed = today.rows[0]?.completed_today || 0;
  const failed = today.rows[0]?.failed_today || 0;
  return {
    dailyLimit: config.dailySiteLimit,
    scheduledToday: today.rows[0]?.scheduled_today || 0,
    completedToday: completed,
    failedToday: failed,
    processedToday: completed + failed,
    states: stateCounts,
    qualifications: qualificationCounts,
    databaseBytes: Number(database.rows[0]?.bytes || 0)
  };
}

async function getHistory(days) {
  const [jobs, eligible] = await Promise.all([
    pool.query(`
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day, status, COUNT(DISTINCT target_id)::int AS count
      FROM crawl_jobs
      WHERE created_at >= NOW() - make_interval(days => $1)
        AND status IN ('done', 'failed')
      GROUP BY day, status
    `, [days]),
    pool.query(`
      SELECT (fetched_at AT TIME ZONE 'UTC')::date AS day, COUNT(DISTINCT target_id)::int AS count
      FROM crawl_snapshots
      WHERE fetched_at >= NOW() - make_interval(days => $1)
        AND eligible
      GROUP BY day
    `, [days])
  ]);

  const byDay = new Map();
  for (const row of jobs.rows) {
    const key = isoDay(row.day);
    const entry = byDay.get(key) || { date: key, completed: 0, failed: 0, eligible: 0 };
    if (row.status === 'done') entry.completed = row.count;
    else if (row.status === 'failed') entry.failed = row.count;
    byDay.set(key, entry);
  }
  for (const row of eligible.rows) {
    const key = isoDay(row.day);
    const entry = byDay.get(key) || { date: key, completed: 0, failed: 0, eligible: 0 };
    entry.eligible = row.count;
    byDay.set(key, entry);
  }

  // Fill gaps so the trend chart has one point per day, oldest first.
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = isoDay(d);
    out.push(byDay.get(key) || { date: key, completed: 0, failed: 0, eligible: 0 });
  }
  return out;
}

async function getSites(limit) {
  const result = await pool.query(`
    SELECT
      t.id,
      t.url,
      t.host,
      t.crawl_state,
      t.qualification_state,
      t.website_type,
      t.last_status_code,
      t.last_error,
      t.last_duration_ms,
      t.last_pages_inspected,
      t.last_eligible,
      t.last_opportunity_score,
      t.last_visual_risk_score,
      t.last_result_at,
      t.total_crawls,
      t.created_at,
      s.title,
      s.meta_description,
      s.emails,
      s.phones,
      s.social_links,
      s.eligibility_reasons,
      s.visual_risk,
      s.tech,
      s.signals,
      s.pages_inspected
    FROM crawl_targets t
    LEFT JOIN LATERAL (
      SELECT title, meta_description, emails, phones, social_links,
             eligibility_reasons, visual_risk, tech, signals, pages_inspected
      FROM crawl_snapshots
      WHERE target_id=t.id
      ORDER BY fetched_at DESC
      LIMIT 1
    ) s ON TRUE
    ORDER BY t.last_result_at DESC NULLS LAST, t.id DESC
    LIMIT $1
  `, [limit]);
  const counted = await pool.query(`SELECT COUNT(*)::int AS total FROM crawl_targets`);
  return { items: result.rows, total: counted.rows[0]?.total || 0 };
}

export async function buildExport({ days = 30, limit = 5000 } = {}) {
  const safeDays = clampInt(days, 30, 1, 90);
  const safeLimit = clampInt(limit, 5000, 1, 20000);
  const [summary, history, sites] = await Promise.all([
    getSummary(),
    getHistory(safeDays),
    getSites(safeLimit)
  ]);
  return {
    version: CRAWL_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workerId: config.workerId,
    dailyLimit: config.dailySiteLimit,
    historyDays: safeDays,
    summary,
    history,
    siteTotal: sites.total,
    siteTruncated: sites.total > sites.items.length,
    sites: sites.items
  };
}

function parseArgs(argv) {
  const out = { out: 'crawl-export.json', days: 30, limit: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--out' || arg === '-o') && argv[i + 1]) out.out = argv[++i];
    else if (arg === '--days' && argv[i + 1]) out.days = argv[++i];
    else if (arg === '--limit' && argv[i + 1]) out.limit = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node src/export.js [--out crawl-export.json] [--days 30] [--limit 5000]');
    console.log('Requires DATABASE_URL (source your .env first: set -a; source .env; set +a).');
    process.exit(0);
  }
  try {
    const payload = await buildExport({ days: args.days, limit: args.limit });
    await writeFile(args.out, JSON.stringify(payload));
    console.log(`exported ${payload.sites.length}/${payload.siteTotal} sites + ${payload.history.length} days of history to ${args.out}`);
  } catch (error) {
    console.error('export failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
