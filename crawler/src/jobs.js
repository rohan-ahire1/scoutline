import { pool } from './db.js';
import { config } from './config.js';

export async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`
      SELECT j.id, j.target_id, t.url, t.host, t.lead_id
      FROM crawl_jobs j
      JOIN crawl_targets t ON t.id = j.target_id
      WHERE j.status = 'queued' AND j.scheduled_for <= NOW() AND t.enabled = TRUE
      ORDER BY t.priority DESC, j.id ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    `);

    if (!found.rowCount) {
      await client.query('COMMIT');
      return null;
    }

    const job = found.rows[0];
    await client.query(`
      UPDATE crawl_jobs
      SET status='running', worker_id=$2, locked_at=NOW(), started_at=NOW(), attempt=attempt+1
      WHERE id=$1
    `, [job.id, config.workerId]);
    await client.query(`
      UPDATE crawl_targets
      SET crawl_state='crawling', last_error=NULL, updated_at=NOW()
      WHERE id=$1
    `, [job.target_id]);
    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markJobDone(jobId) {
  await pool.query(`
    UPDATE crawl_jobs SET status='done', finished_at=NOW(), error=NULL WHERE id=$1
  `, [jobId]);
}

export async function markJobFailed(jobId, error) {
  const message = String(error).slice(0, 4000);
  await pool.query(`
    WITH failed AS (
      UPDATE crawl_jobs
      SET status='failed', finished_at=NOW(), error=$2
      WHERE id=$1
      RETURNING target_id
    )
    UPDATE crawl_targets t
    SET crawl_state='failed', last_error=$2, last_result_at=NOW(), updated_at=NOW()
    FROM failed f
    WHERE t.id=f.target_id
  `, [jobId, message]);
}

export async function recoverStaleJobs() {
  const result = await pool.query(`
    WITH stale AS (
      UPDATE crawl_jobs
      SET status='queued', worker_id=NULL, locked_at=NULL, started_at=NULL,
          error='Recovered after stale worker timeout'
      WHERE status='running'
        AND COALESCE(locked_at, started_at, created_at) < NOW() - ($1 || ' minutes')::interval
      RETURNING target_id
    )
    UPDATE crawl_targets t
    SET crawl_state='queued', updated_at=NOW()
    FROM stale s
    WHERE t.id=s.target_id
    RETURNING t.id
  `, [config.staleJobMinutes]);
  return result.rowCount;
}
