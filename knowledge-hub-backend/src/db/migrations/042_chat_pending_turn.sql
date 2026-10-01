-- 042_chat_pending_turn.sql
-- Chat turns now run on the server in the background (the browser can close
-- or refresh). While one is running its message is recorded here, so a turn
-- cut off by a restart/deploy shows as "interrupted — resend" instead of
-- silently disappearing. Cleared when the turn finishes, fails or is stopped.

ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS pending_turn JSONB;
