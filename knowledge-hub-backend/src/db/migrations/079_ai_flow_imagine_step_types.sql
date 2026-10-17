-- 079_ai_flow_imagine_step_types.sql
-- AI flow step types now follow the Imagine agent types. Renames stored step
-- types (ai_orchestration -> digital_steward, ai_agent_task -> digital_worker)
-- in current documents, revisions and named versions. Shapes still carrying the
-- old default label are relabelled too; user-written labels are left alone.

CREATE OR REPLACE FUNCTION pg_temp.imagine_step_types(doc jsonb) RETURNS jsonb AS $$
  SELECT CASE WHEN jsonb_typeof(doc->'nodes') <> 'array' THEN doc ELSE jsonb_set(doc, '{nodes}', COALESCE((
    SELECT jsonb_agg(
      CASE WHEN m.new_type IS NULL THEN n
      ELSE jsonb_set(
        CASE WHEN n->>'label' = m.old_label THEN jsonb_set(n, '{label}', to_jsonb(m.new_label)) ELSE n END,
        '{flow,stepType}', to_jsonb(m.new_type))
      END ORDER BY ord)
    FROM jsonb_array_elements(doc->'nodes') WITH ORDINALITY AS e(n, ord)
    LEFT JOIN (VALUES
      ('ai_orchestration', 'digital_steward', 'AI orchestration', 'Digital Steward'),
      ('ai_agent_task', 'digital_worker', 'AI agent task', 'Digital Worker')
    ) AS m(old_type, new_type, old_label, new_label) ON m.old_type = n->'flow'->>'stepType'
  ), '[]'::jsonb)) END
$$ LANGUAGE sql IMMUTABLE;

UPDATE canvas_diagrams SET document = pg_temp.imagine_step_types(document)
WHERE document::text LIKE '%"ai_agent_task"%' OR document::text LIKE '%"ai_orchestration"%';

UPDATE canvas_diagram_revisions SET document = pg_temp.imagine_step_types(document)
WHERE document::text LIKE '%"ai_agent_task"%' OR document::text LIKE '%"ai_orchestration"%';

UPDATE canvas_diagram_versions SET document = pg_temp.imagine_step_types(document)
WHERE document::text LIKE '%"ai_agent_task"%' OR document::text LIKE '%"ai_orchestration"%';
