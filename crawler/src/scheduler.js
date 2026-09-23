import { query } from './db.js';
import { config } from './config.js';

export async function scheduleDueTargets(batchLimit = 500) {
  const usedResult = await query(`
    SELECT COUNT(DISTINCT target_id)::int AS used
    FROM crawl_jobs
    WHERE created_at >= CURRENT_DATE
  `);
  const used = usedResult.rows[0]?.used || 0;
  const remaining = Math.max(0, config.dailySiteLimit - used);
  if (remaining <= 0) return 0;

  const limit = Math.min(batchLimit, remaining);
  const sql = `
    WITH due AS (
      SELECT id
      FROM crawl_targets
      WHERE enabled = TRUE AND next_crawl_at <= NOW()
      ORDER BY priority DESC, next_crawl_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    ), inserted AS (
      INSERT INTO crawl_jobs (target_id, status, scheduled_for)
      SELECT id, 'queued', NOW() FROM due
      ON CONFLICT DO NOTHING
      RETURNING target_id
    )
    UPDATE crawl_targets t
    SET next_crawl_at = NOW() + (t.interval_minutes || ' minutes')::interval,
        crawl_state = 'queued',
        updated_at = NOW()
    FROM inserted i
    WHERE t.id = i.target_id
    RETURNING t.id;
  `;
  const result = await query(sql, [limit]);
  return result.rowCount;
}
