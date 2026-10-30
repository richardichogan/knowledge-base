ALTER TABLE learning_sessions ADD COLUMN question_count INTEGER NOT NULL DEFAULT 5 CHECK (question_count IN (5,10));
ALTER TABLE learning_sessions ALTER COLUMN question_count SET DEFAULT 10;
ALTER TABLE learning_sessions ADD COLUMN daily_for DATE;
ALTER TABLE learning_sessions ADD COLUMN question_plan JSONB;
CREATE UNIQUE INDEX learning_sessions_daily ON learning_sessions(owner_id, daily_for) WHERE daily_for IS NOT NULL;
ALTER TABLE learning_items DROP CONSTRAINT learning_items_position_check;
ALTER TABLE learning_items ADD CONSTRAINT learning_items_position_check CHECK (position BETWEEN 0 AND 9);
CREATE INDEX learning_items_answer_history ON learning_items(answered_at DESC) WHERE chosen IS NOT NULL;
