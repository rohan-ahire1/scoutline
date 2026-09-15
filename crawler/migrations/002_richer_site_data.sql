ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS canonical TEXT;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS lang TEXT;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS addresses JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS structured_types JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS visual_risk JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS eligible BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS eligibility_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS pages_inspected INTEGER NOT NULL DEFAULT 1;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS pages JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_snapshots_eligible_score
  ON crawl_snapshots (eligible, opportunity_score DESC, fetched_at DESC);
