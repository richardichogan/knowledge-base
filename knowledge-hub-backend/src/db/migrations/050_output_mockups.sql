-- 050_output_mockups.sql
-- Outputs can be a web page mock-up (format 'html'): one self-contained page
-- the Outputs panel shows rendered, in a sealed frame, at desktop/tablet/mobile widths.
ALTER TABLE chat_outputs DROP CONSTRAINT IF EXISTS chat_outputs_format_check;
ALTER TABLE chat_outputs ADD CONSTRAINT chat_outputs_format_check CHECK (format IN ('markdown', 'text', 'html'));
