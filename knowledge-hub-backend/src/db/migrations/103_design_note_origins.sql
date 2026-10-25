-- Legacy use cases live as typed Think notes. Link their parents without rewriting notes.
ALTER TABLE designs ADD COLUMN IF NOT EXISTS source_note_id UUID UNIQUE REFERENCES notes(id) ON DELETE SET NULL;
