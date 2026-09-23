-- Lead-quality fields: dated-site signals, ranked/verified emails, owner
-- names and the home URL fallback (broken HTTPS, www vs apex).
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS dated JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS ranked_emails JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS owners JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS family_owned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE crawl_snapshots ADD COLUMN IF NOT EXISTS home_fallback JSONB;
ALTER TABLE crawl_targets ADD COLUMN IF NOT EXISTS last_dated_score INTEGER;
