CREATE TABLE IF NOT EXISTS crawl_targets (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT,
  url TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 50,
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  next_crawl_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_crawl_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_targets_due
  ON crawl_targets (enabled, next_crawl_at, priority DESC);

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES crawl_targets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  worker_id TEXT,
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_job_per_target
  ON crawl_jobs (target_id)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS idx_jobs_queue
  ON crawl_jobs (status, scheduled_for, id);

CREATE TABLE IF NOT EXISTS crawl_snapshots (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES crawl_targets(id) ON DELETE CASCADE,
  job_id BIGINT REFERENCES crawl_jobs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_url TEXT NOT NULL,
  final_url TEXT,
  status_code INTEGER,
  content_type TEXT,
  latency_ms INTEGER,
  response_bytes INTEGER,
  sha256 TEXT,
  changed BOOLEAN NOT NULL DEFAULT TRUE,
  title TEXT,
  meta_description TEXT,
  h1 TEXT,
  text_length INTEGER,
  links_count INTEGER,
  internal_links_count INTEGER,
  external_links_count INTEGER,
  emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  phones JSONB NOT NULL DEFAULT '[]'::jsonb,
  tech JSONB NOT NULL DEFAULT '{}'::jsonb,
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  opportunity_score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_target_time
  ON crawl_snapshots (target_id, fetched_at DESC);
