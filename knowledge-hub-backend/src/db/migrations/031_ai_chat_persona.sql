-- 031_ai_chat_persona.sql
-- Adds a persona field to ai_chat_sessions so a session can run as either
-- Athena's default "general" assistant persona or the "brainstorming" sounding
-- board persona (adapted from the user's M365 Copilot "ideas sounding board"
-- agent). Persona is per-session, not per-message, so switching mid-chat is
-- an explicit user action rather than an inferred one.

ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS persona TEXT NOT NULL DEFAULT 'general';
