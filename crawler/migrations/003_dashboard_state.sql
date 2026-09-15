ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS crawl_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS qualification_state TEXT NOT NULL DEFAULT 'not_evaluated';
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS website_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_status_code INTEGER;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_duration_ms INTEGER;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_pages_inspected INTEGER;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_eligible BOOLEAN;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_opportunity_score INTEGER;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_visual_risk_score INTEGER;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_result_at TIMESTAMPTZ;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS total_crawls INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS website_type TEXT NOT NULL DEFAULT 'unknown';

DO $$ BEGIN
  ALTER TABLE crawl_targets ADD CONSTRAINT crawl_targets_state_check
    CHECK (crawl_state IN ('pending','queued','crawling','completed','failed','blocked','disabled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crawl_targets ADD CONSTRAINT crawl_targets_qualification_check
    CHECK (qualification_state IN ('not_evaluated','eligible','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_targets_dashboard_state
  ON crawl_targets (crawl_state, qualification_state, last_result_at DESC);

CREATE INDEX IF NOT EXISTS idx_targets_dashboard_score
  ON crawl_targets (last_eligible, last_opportunity_score DESC, last_result_at DESC);

-- Backfill website type for snapshots created before this migration.
UPDATE crawl_snapshots
SET website_type = CASE
  WHEN tech->>'shopify' = 'true' THEN 'shopify'
  WHEN tech->>'staticCandidate' = 'true' THEN 'static'
  WHEN tech->>'woocommerce' = 'true' THEN 'woocommerce'
  WHEN tech->>'wordpress' = 'true' THEN 'wordpress'
  WHEN tech->>'wix' = 'true' THEN 'wix'
  WHEN tech->>'squarespace' = 'true' THEN 'squarespace'
  WHEN tech->>'webflow' = 'true' THEN 'webflow'
  WHEN tech->>'nextjs' = 'true' THEN 'nextjs'
  WHEN tech->>'nuxt' = 'true' THEN 'nuxt'
  WHEN tech->>'magento' = 'true' THEN 'magento'
  WHEN tech->>'bigcommerce' = 'true' THEN 'bigcommerce'
  WHEN tech->>'drupal' = 'true' THEN 'drupal'
  WHEN tech->>'react' = 'true' OR tech->>'angular' = 'true' THEN 'dynamic'
  ELSE 'unknown'
END
WHERE website_type = 'unknown';

-- Backfill target state from the latest existing crawl data so an upgrade does not
-- make previously crawled sites appear "pending" until their next crawl.
WITH latest_snapshot AS (
  SELECT DISTINCT ON (target_id)
    target_id, fetched_at, status_code, eligible, opportunity_score, pages_inspected,
    website_type, visual_risk, signals, latency_ms
  FROM crawl_snapshots
  ORDER BY target_id, fetched_at DESC
), latest_job AS (
  SELECT DISTINCT ON (target_id)
    target_id, status, finished_at, started_at, error, created_at
  FROM crawl_jobs
  ORDER BY target_id, created_at DESC, id DESC
), crawl_counts AS (
  SELECT target_id, COUNT(*)::int AS total
  FROM crawl_snapshots
  GROUP BY target_id
)
UPDATE crawl_targets t
SET crawl_state = CASE
      WHEN t.enabled = FALSE THEN 'disabled'
      WHEN j.status = 'running' THEN 'crawling'
      WHEN j.status = 'queued' THEN 'queued'
      WHEN j.status = 'failed' AND (s.fetched_at IS NULL OR j.created_at > s.fetched_at) THEN 'failed'
      WHEN COALESCE((s.signals->>'blockedByRobots')::boolean, FALSE) THEN 'blocked'
      WHEN s.target_id IS NOT NULL THEN 'completed'
      ELSE 'pending'
    END,
    qualification_state = CASE
      WHEN s.target_id IS NULL OR COALESCE((s.signals->>'blockedByRobots')::boolean, FALSE) THEN 'not_evaluated'
      WHEN s.eligible THEN 'eligible'
      ELSE 'rejected'
    END,
    website_type = COALESCE(s.website_type, 'unknown'),
    last_status_code = s.status_code,
    last_error = CASE WHEN j.status='failed' THEN j.error ELSE NULL END,
    last_duration_ms = s.latency_ms,
    last_pages_inspected = s.pages_inspected,
    last_eligible = CASE WHEN s.target_id IS NULL THEN NULL ELSE s.eligible END,
    last_opportunity_score = s.opportunity_score,
    last_visual_risk_score = NULLIF(s.visual_risk->>'score','')::int,
    last_result_at = COALESCE(s.fetched_at, j.finished_at),
    total_crawls = COALESCE(c.total, 0),
    updated_at = NOW()
FROM latest_job j
FULL JOIN latest_snapshot s ON s.target_id=j.target_id
LEFT JOIN crawl_counts c ON c.target_id=COALESCE(j.target_id,s.target_id)
WHERE t.id=COALESCE(j.target_id,s.target_id);
