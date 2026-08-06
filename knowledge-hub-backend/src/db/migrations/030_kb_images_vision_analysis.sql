-- Add vision_analysis column to kb_images for GPT-4V semantic image understanding
ALTER TABLE kb_images
  ADD COLUMN IF NOT EXISTS vision_analysis TEXT NOT NULL DEFAULT '';

-- Update search vector trigger to include vision_analysis
CREATE OR REPLACE FUNCTION kb_images_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.caption, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.vision_analysis, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.ocr_text, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger to apply new function
DROP TRIGGER IF EXISTS kb_images_tsvector_trigger ON kb_images;
CREATE TRIGGER kb_images_tsvector_trigger
  BEFORE INSERT OR UPDATE ON kb_images
  FOR EACH ROW EXECUTE FUNCTION kb_images_search_vector_update();
