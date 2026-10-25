ALTER TABLE designs ADD COLUMN IF NOT EXISTS parent_note_id UUID UNIQUE REFERENCES notes(id) ON DELETE CASCADE;
ALTER TABLE designs ADD COLUMN IF NOT EXISTS selections JSONB NOT NULL DEFAULT '{}';

-- The approved initial mapping creates parents only; original Use Case writing is untouched.
INSERT INTO designs(title,project_id,source_note_id)
SELECT note_list_metadata(n.content)->>'title',n.project_id,n.id
FROM notes n WHERE n.status='active' AND note_list_metadata(n.content)->>'contentType'='use-case'
  AND n.id IN (
    'cc01794e-fb4e-4cca-84e6-00d0c4e1a918',
    '881a842d-8ae1-4c60-a266-90147a3be866',
    'b028adff-5851-4203-915f-67f2ab889433',
    'c6648add-3d0e-4942-abf0-1c7d833009bf',
    '20cc6121-11f0-4b4a-84d6-8cbdebf1a9fc'
  )
  AND NOT EXISTS(SELECT 1 FROM designs d WHERE d.source_note_id=n.id);

DO $$
DECLARE d RECORD; parent UUID;
BEGIN
  FOR d IN SELECT * FROM designs WHERE parent_note_id IS NULL LOOP
    INSERT INTO notes(content,project_id)
    VALUES(jsonb_build_object('title',d.title,'contentType','design','contentJson','[]')::text,d.project_id)
    RETURNING id INTO parent;
    UPDATE designs SET parent_note_id=parent WHERE id=d.id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ensure_design_note_parent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF note_list_metadata(NEW.content)->>'contentType'='design' THEN
    INSERT INTO designs(id,parent_note_id,title,project_id)
    VALUES(NEW.id,NEW.id,note_list_metadata(NEW.content)->>'title',NEW.project_id)
    ON CONFLICT(parent_note_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notes_ensure_design AFTER INSERT OR UPDATE OF content ON notes
FOR EACH ROW EXECUTE FUNCTION ensure_design_note_parent();

CREATE TABLE design_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  sources JSONB NOT NULL,
  blueprint JSONB NOT NULL,
  html TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(design_id,revision)
);
CREATE TABLE design_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES design_artifacts(id),
  element_id TEXT NOT NULL,
  selection TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL,
  request_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','proposed','accepted','discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE design_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES design_artifacts(id),
  feedback_ids UUID[] NOT NULL,
  sources JSONB NOT NULL,
  changes JSONB NOT NULL,
  explanation TEXT NOT NULL,
  blueprint JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX design_one_pending_proposal ON design_proposals(design_id) WHERE status='pending';
CREATE TABLE design_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  files JSONB NOT NULL,
  manifest JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE design_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES design_packages(id),
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  folder TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','publishing','published','failed')),
  commit_sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
