-- No prompt/source text. NULL on legacy rows means not measured, not compliant.
ALTER TABLE knowledge_turn_audit ADD COLUMN IF NOT EXISTS retrieval_scope JSONB;
ALTER TABLE knowledge_turn_audit ADD COLUMN IF NOT EXISTS environment TEXT;
