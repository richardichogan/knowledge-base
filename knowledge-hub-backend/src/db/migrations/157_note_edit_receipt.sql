-- What the live editor reported after applying the note edits attached to an assistant reply.
ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS note_edit_receipt JSONB;
