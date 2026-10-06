-- 057_build_integration_branch.sql
-- Build specs work on their own integration branch (build/<slug>) cut from
-- base_branch when the build starts. Agent PRs merge into it; when every task
-- is merged the runner opens one PR from it back into base_branch.
-- Additive and idempotent.

ALTER TABLE build_specs ADD COLUMN IF NOT EXISTS use_work_branch     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE build_specs ADD COLUMN IF NOT EXISTS work_branch         TEXT;
ALTER TABLE build_specs ADD COLUMN IF NOT EXISTS final_pr_number     INTEGER;
ALTER TABLE build_specs ADD COLUMN IF NOT EXISTS final_pr_url        TEXT;
ALTER TABLE build_specs ADD COLUMN IF NOT EXISTS final_pr_merged_at  TIMESTAMPTZ;
