ALTER TABLE ai_workflow_runs ADD COLUMN IF NOT EXISTS failure_stage TEXT;
ALTER TABLE ai_workflow_runs ADD COLUMN IF NOT EXISTS failure_code TEXT
  CHECK (failure_code IN (
    'cancelled', 'timeout', 'provider-http', 'provider-refused', 'provider-empty',
    'provider-incomplete', 'response-truncated', 'source-forbidden', 'operation-error', 'unclassified'
  ));
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS failure_code TEXT
  CHECK (failure_code IN (
    'cancelled', 'timeout', 'provider-http', 'provider-refused', 'provider-empty',
    'provider-incomplete', 'response-truncated', 'source-forbidden', 'operation-error', 'unclassified'
  ));

-- This exact message is emitted only when usable vision text hit its output limit.
UPDATE ai_usage_log SET failure_code='response-truncated'
  WHERE failure_code IS NULL AND NOT ok AND error='Vision response was truncated'
    AND feature IN ('image-description','screen-read','screen-review');
