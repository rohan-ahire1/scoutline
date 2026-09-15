import { pool } from './db.js';
import { classifyWebsiteType } from './state.js';

export async function storeSnapshot(job, fetched, analysis = null) {
  const client = await pool.connect();
  try {
  const previous = await client.query(`
    SELECT sha256 FROM crawl_snapshots
    WHERE target_id=$1 AND sha256 IS NOT NULL
    ORDER BY fetched_at DESC LIMIT 1
  `, [job.target_id]);
  const changed = !previous.rowCount || previous.rows[0].sha256 !== fetched.sha256;

  const a = analysis || {};
  const websiteType = a.websiteType || classifyWebsiteType(a.tech || {});
  const blocked = Boolean(fetched.blockedByRobots);
  const evaluated = Boolean(analysis);
  const qualificationState = !evaluated ? 'not_evaluated' : (a.eligible ? 'eligible' : 'rejected');
  const crawlState = blocked ? 'blocked' : 'completed';
  const totalDurationMs = Array.isArray(a.pages)
    ? a.pages.reduce((sum, page) => sum + (Number(page.latencyMs) || 0), 0)
    : (Number(fetched.latencyMs) || 0);

  await client.query('BEGIN');
    await client.query(`
      INSERT INTO crawl_snapshots (
        target_id, job_id, requested_url, final_url, status_code, content_type,
        latency_ms, response_bytes, sha256, changed, title, meta_description, h1,
        canonical, lang, text_length, links_count, internal_links_count, external_links_count,
        emails, phones, social_links, addresses, structured_types, tech, signals,
        visual_risk, eligible, eligibility_reasons, opportunity_score, pages_inspected, pages,
        website_type
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,$24::jsonb,$25::jsonb,$26::jsonb,$27::jsonb,
        $28,$29::jsonb,$30,$31,$32::jsonb,$33
      )
    `, [
      job.target_id,
      job.id,
      fetched.requestedUrl,
      fetched.finalUrl || null,
      fetched.statusCode || null,
      fetched.contentType || null,
      fetched.latencyMs || null,
      fetched.responseBytes || null,
      fetched.sha256 || null,
      changed,
      a.title || null,
      a.metaDescription || null,
      a.h1 || null,
      a.canonical || null,
      a.lang || null,
      a.textLength || null,
      a.linksCount || 0,
      a.internalLinksCount || 0,
      a.externalLinksCount || 0,
      JSON.stringify(a.emails || []),
      JSON.stringify(a.phones || []),
      JSON.stringify(a.socialLinks || []),
      JSON.stringify(a.addresses || []),
      JSON.stringify(a.structuredTypes || []),
      JSON.stringify(a.tech || {}),
      JSON.stringify(blocked ? { blockedByRobots: true } : (a.signals || {})),
      JSON.stringify(a.visualRisk || {}),
      Boolean(a.eligible),
      JSON.stringify(a.eligibilityReasons || []),
      a.opportunityScore || 0,
      a.pagesInspected || 1,
      JSON.stringify(a.pages || []),
      websiteType
    ]);

    await client.query(`
      UPDATE crawl_targets
      SET last_crawl_at=NOW(),
          crawl_state=$2,
          qualification_state=$3,
          website_type=$4,
          last_status_code=$5,
          last_error=NULL,
          last_duration_ms=$6,
          last_pages_inspected=$7,
          last_eligible=$8,
          last_opportunity_score=$9,
          last_visual_risk_score=$10,
          last_result_at=NOW(),
          total_crawls=total_crawls+1,
          updated_at=NOW()
      WHERE id=$1
    `, [
      job.target_id,
      crawlState,
      qualificationState,
      websiteType,
      fetched.statusCode || null,
      totalDurationMs,
      a.pagesInspected || 1,
      evaluated ? Boolean(a.eligible) : null,
      evaluated ? (a.opportunityScore || 0) : null,
      evaluated ? (a.visualRisk?.score || 0) : null
    ]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
