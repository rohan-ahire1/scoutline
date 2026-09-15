import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './db.js';
import { config } from './config.js';
import { buildExport } from './export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardPath = path.join(__dirname, 'dashboard', 'index.html');

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function parseLimit(value, fallback = 100) {
  const n = Number.parseInt(value || '', 10);
  return Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : fallback;
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
  return {
    dailyLimit: config.dailySiteLimit,
    scheduledToday: today.rows[0]?.scheduled_today || 0,
    completedToday: today.rows[0]?.completed_today || 0,
    failedToday: today.rows[0]?.failed_today || 0,
    processedToday: (today.rows[0]?.completed_today || 0) + (today.rows[0]?.failed_today || 0),
    states: stateCounts,
    qualifications: qualificationCounts,
    databaseBytes: Number(database.rows[0]?.bytes || 0)
  };
}

async function getSites(searchParams) {
  const state = searchParams.get('state');
  const qualification = searchParams.get('qualification');
  const q = (searchParams.get('q') || '').trim();
  const limit = parseLimit(searchParams.get('limit'));
  const offset = Math.max(0, Number.parseInt(searchParams.get('offset') || '0', 10) || 0);
  const sort = searchParams.get('sort') || 'recent';

  const clauses = [];
  const values = [];
  const add = value => { values.push(value); return `$${values.length}`; };

  if (state && state !== 'all') clauses.push(`t.crawl_state = ${add(state)}`);
  if (qualification && qualification !== 'all') clauses.push(`t.qualification_state = ${add(qualification)}`);
  if (q) clauses.push(`(t.url ILIKE ${add(`%${q}%`)} OR COALESCE(s.title,'') ILIKE ${add(`%${q}%`)})`);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = sort === 'opportunity'
    ? `ORDER BY t.last_eligible DESC NULLS LAST, t.last_opportunity_score DESC NULLS LAST, t.last_result_at DESC NULLS LAST`
    : `ORDER BY t.updated_at DESC, t.id DESC`;

  const filterValues = [...values];
  const countResult = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM crawl_targets t
    LEFT JOIN LATERAL (
      SELECT title
      FROM crawl_snapshots
      WHERE target_id=t.id
      ORDER BY fetched_at DESC
      LIMIT 1
    ) s ON TRUE
    ${where}
  `, filterValues);

  values.push(limit, offset);
  const limitParam = `$${values.length - 1}`;
  const offsetParam = `$${values.length}`;

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
      s.title,
      s.emails,
      s.phones,
      s.eligibility_reasons,
      s.tech,
      s.changed
    FROM crawl_targets t
    LEFT JOIN LATERAL (
      SELECT title, emails, phones, eligibility_reasons, tech, changed
      FROM crawl_snapshots
      WHERE target_id=t.id
      ORDER BY fetched_at DESC
      LIMIT 1
    ) s ON TRUE
    ${where}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `, values);

  return { items: result.rows, total: countResult.rows[0]?.total || 0, limit, offset };
}

async function getSite(id) {
  const target = await pool.query(`
    SELECT * FROM crawl_targets WHERE id=$1
  `, [id]);
  if (!target.rowCount) return null;
  const snapshots = await pool.query(`
    SELECT id, fetched_at, requested_url, final_url, status_code, latency_ms, response_bytes,
           changed, title, meta_description, h1, emails, phones, social_links, addresses,
           structured_types, tech, signals, visual_risk, eligible, eligibility_reasons,
           opportunity_score, pages_inspected, pages, website_type
    FROM crawl_snapshots
    WHERE target_id=$1
    ORDER BY fetched_at DESC
    LIMIT 10
  `, [id]);
  return { target: target.rows[0], snapshots: snapshots.rows };
}

export function startDashboardServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method !== 'GET') return text(res, 405, 'Method not allowed');
      if (url.pathname === '/health') return json(res, 200, { ok: true });
      if (url.pathname === '/api/summary') return json(res, 200, await getSummary());
      if (url.pathname === '/api/export') {
        return json(res, 200, await buildExport({
          days: url.searchParams.get('days') || 30,
          limit: url.searchParams.get('limit') || 5000
        }));
      }
      if (url.pathname === '/api/sites') return json(res, 200, await getSites(url.searchParams));
      if (url.pathname.startsWith('/api/sites/')) {
        const id = Number.parseInt(url.pathname.split('/').pop(), 10);
        if (!Number.isFinite(id)) return json(res, 400, { error: 'Invalid site id' });
        const site = await getSite(id);
        return site ? json(res, 200, site) : json(res, 404, { error: 'Not found' });
      }
      if (url.pathname === '/' || url.pathname === '/dashboard') {
        const html = await readFile(dashboardPath, 'utf8');
        return text(res, 200, html, 'text/html; charset=utf-8');
      }
      return text(res, 404, 'Not found');
    } catch (error) {
      console.error('dashboard request error', error);
      return json(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    console.log(`Dashboard listening on http://${config.dashboardHost}:${config.dashboardPort}`);
  });
  return server;
}
