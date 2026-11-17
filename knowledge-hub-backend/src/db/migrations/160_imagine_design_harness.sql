ALTER TABLE designs ADD COLUMN IF NOT EXISTS imagine_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS imagine_harness JSONB NOT NULL DEFAULT '{}';

ALTER TABLE design_assets DROP CONSTRAINT IF EXISTS design_assets_role_check;
ALTER TABLE design_assets ADD CONSTRAINT design_assets_role_check
  CHECK (role IN ('use_case', 'spec', 'architecture', 'diagram', 'reference', 'workforce'));
