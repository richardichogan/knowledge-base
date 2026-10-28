-- Brainstorm cards: a chosen card type (topic, idea, question …), a footnote, and whether the card's children are collapsed.
ALTER TABLE canvas_nodes ADD COLUMN IF NOT EXISTS card_type TEXT;
ALTER TABLE canvas_nodes ADD COLUMN IF NOT EXISTS footnote TEXT;
ALTER TABLE canvas_nodes ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;
