import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { asPool } from './semantic-fixture.js';
import { parseAtlasQuery, readGraphAtlas } from '../src/services/graphAtlas.js';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-29T08:00:00Z');

test('atlas projects authoritative entities, every saved relationship family and removals', async t => {
  const raw = new PGlite();
  const db = asPool(raw);
  try {
    await raw.exec(`
      CREATE FUNCTION note_list_metadata(raw text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS 'SELECT raw::jsonb';
      CREATE TABLE projects(id text PRIMARY KEY,name text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE companies(id uuid PRIMARY KEY,name text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE people(id uuid PRIMARY KEY,name text,company_id uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE company_projects(company_id uuid,project_id text);
      CREATE TABLE person_project_roles(person_id uuid,project_id text,company_id uuid,role text);
      CREATE TABLE notes(id uuid PRIMARY KEY,content text,tags text[] DEFAULT '{}',linked_items uuid[] DEFAULT '{}',status text DEFAULT 'active',
        project_id text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE tags(id uuid PRIMARY KEY,name text,parent_id uuid,role text DEFAULT 'concept',project_id text,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE note_tags(note_id uuid,tag_id uuid,source text DEFAULT 'auto');
      CREATE TABLE tasks(id text PRIMARY KEY,title text,archived boolean DEFAULT false,project_id text,linked_tag_id uuid,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE task_tags(task_id text,tag_id uuid,source text DEFAULT 'manual');
      CREATE TABLE content_items(id uuid PRIMARY KEY,source text,source_id text,title text,url text,project_context text,tags text[] DEFAULT '{}',
        metadata jsonb DEFAULT '{}',published_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE discover_item_tags(discover_item_id uuid,tag_id uuid,source text DEFAULT 'auto');
      CREATE TABLE document_tags(doc_id text,tag_id uuid);
      CREATE TABLE content_item_tags(content_item_id uuid,tag_id uuid);
      CREATE TABLE cfp_items(id uuid PRIMARY KEY,conference_name text,tags text[] DEFAULT '{}',discovered_at timestamptz DEFAULT now());
      CREATE TABLE cfp_item_tags(cfp_item_id uuid,tag_id uuid);
      CREATE TABLE note_github_publications(note_id uuid,repo text,path text);
      CREATE TABLE sparks(id uuid PRIMARY KEY,body text,tags text[] DEFAULT '{}',source_type text,source_id text,cluster_id uuid,
        used_type text,used_ref text,used_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE spark_clusters(id uuid PRIMARY KEY,theme text,output_type text,output_ref text,developed_at timestamptz,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE canvases(id uuid PRIMARY KEY,title text,project text,canvas_type text DEFAULT 'diagram',deleted_at timestamptz,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE canvas_notes(canvas_id uuid,note_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE canvas_nodes(id uuid PRIMARY KEY,canvas_id uuid,ref_type text,ref_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE canvas_edges(id uuid PRIMARY KEY,canvas_id uuid,source_id uuid,target_id uuid,edge_type text,label text,created_at timestamptz DEFAULT now());
      CREATE TABLE canvas_diagrams(canvas_id uuid,document jsonb);
      CREATE TABLE diagram_element_notes(canvas_id uuid,element_id uuid,note_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE diagram_drilldowns(canvas_id uuid,node_id uuid,child_canvas_id uuid);
      CREATE TABLE entity_manual_links(id uuid,a_type text,a_id text,a_element text,b_type text,b_id text,b_element text,created_at timestamptz DEFAULT now());
      CREATE TABLE use_cases(id uuid PRIMARY KEY,title text,project_id text,stage text DEFAULT 'candidate',spec_note_id uuid,build_spec_id uuid,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE use_case_sources(use_case_id uuid,source_type text,source_id text,added_at timestamptz DEFAULT now());
      CREATE TABLE use_case_links(id uuid,use_case_id uuid,url text,added_at timestamptz DEFAULT now());
      CREATE TABLE designs(id uuid PRIMARY KEY,parent_note_id uuid,source_note_id uuid,source_use_case_id uuid);
      CREATE TABLE design_assets(design_id uuid,source_type text,source_id text,role text,excluded boolean DEFAULT false);
      CREATE TABLE ai_chat_sessions(id uuid PRIMARY KEY,title text,project_id text,note_id text,started_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE chat_decisions(id uuid PRIMARY KEY,session_id uuid,text text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE chat_outputs(id uuid PRIMARY KEY,session_id uuid,title text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE build_specs(id uuid PRIMARY KEY,title text,project_id text,note_id uuid,chat_output_id uuid,final_pr_url text,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE build_tasks(id uuid,spec_id uuid,pr_url text);
      CREATE TABLE project_register_items(id uuid PRIMARY KEY,kind text,title text,project_id text,source_type text,source_id text,task_id text,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE task_links(id uuid,task_id text,target_type text,target_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE note_extractions(id uuid,note_id uuid,target_type text,target_id text,action text,created_at timestamptz DEFAULT now());
      CREATE TABLE semantic_edges(id uuid,from_kind text,from_id text,to_kind text,to_id text,relationship text,origin text,note text,
        effective_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE nodes(id uuid PRIMARY KEY,ref_type text,ref_id text);
      CREATE TABLE edges(id uuid,source_node_id uuid,target_node_id uuid,edge_type text,confidence real DEFAULT 1,metadata jsonb,created_at timestamptz DEFAULT now());
    `);
    await raw.exec(await readFile(new URL('../src/db/migrations/082_note_links.sql', import.meta.url), 'utf8'));
    await raw.exec(`
      ALTER TABLE note_entity_links DROP CONSTRAINT note_entity_links_target_type_check;
      INSERT INTO projects(id,name) VALUES ('p','Project');
      INSERT INTO companies(id,name) VALUES ('${id(20)}','Company');
      INSERT INTO people(id,name,company_id) VALUES ('${id(21)}','Person','${id(20)}');
      INSERT INTO company_projects VALUES ('${id(20)}','p');
      INSERT INTO person_project_roles VALUES ('${id(21)}','p','${id(20)}','Architect');
      INSERT INTO notes(id,content,project_id) VALUES
        ('${id(1)}','{"title":"Root"}','p'),('${id(2)}','{"title":"Linked note"}','p'),
        ('${id(3)}','{"title":"Design","contentType":"design"}','p'),('${id(4)}','{"title":"Archived"}','p');
      UPDATE notes SET status='archived' WHERE id='${id(4)}';
      INSERT INTO tags(id,name,parent_id,project_id) VALUES ('${id(30)}','Agentic',NULL,NULL),
        ('${id(31)}','AI',NULL,'p'),('${id(32)}','Other',NULL,NULL);
      UPDATE tags SET parent_id='${id(31)}' WHERE id='${id(30)}';
      INSERT INTO tasks(id,title,project_id) VALUES ('t','Task','p');
      INSERT INTO content_items(id,source,source_id,title,url,project_context,metadata) VALUES
        ('${id(10)}','discovered-article','article','Article','https://example.test/article','p','{}'),
        ('${id(11)}','github-doc','doc','Document','https://example.test/doc','p','{"repo":"owner/repo","path":"spec.md"}'),
        ('${id(12)}','github-pr','pr','PR','https://example.test/pr','p','{}'),
        ('${id(13)}','email','mail','Email',NULL,'p','{}'),
        ('${id(14)}','graph-calendar','event','Meeting',NULL,'p','{}'),
        ('${id(15)}','cms-blog','post','Blog','https://example.test/post','p','{}'),
        ('${id(16)}','cms-podcast-show-notes','episode','Podcast','https://example.test/episode','p','{}'),
        ('${id(17)}','github-doc','mirror','Mirror',NULL,'p','{"repo":"owner/repo","path":"note.md"}'),
        ('${id(18)}','note','${id(2)}','Note index mirror',NULL,'p','{}');
      INSERT INTO note_github_publications VALUES ('${id(2)}','owner/repo','note.md');
      INSERT INTO cfp_items(id,conference_name) VALUES ('${id(19)}','Conference');
      INSERT INTO note_tags VALUES ('${id(1)}','${id(30)}','auto');
      INSERT INTO discover_item_tags VALUES ('${id(10)}','${id(30)}','auto');
      INSERT INTO task_tags VALUES ('t','${id(30)}','manual');
      INSERT INTO document_tags VALUES ('owner/repo::spec.md','${id(30)}');
      INSERT INTO content_item_tags VALUES ('${id(13)}','${id(30)}');
      INSERT INTO cfp_item_tags VALUES ('${id(19)}','${id(30)}');
      INSERT INTO spark_clusters(id,theme,output_type,output_ref) VALUES ('${id(40)}','Theme','note','${id(2)}');
      INSERT INTO sparks(id,body,source_type,source_id,cluster_id,used_type,used_ref)
        VALUES ('${id(41)}','Spark','content_item','${id(10)}','${id(40)}','note','${id(2)}');
      INSERT INTO canvases(id,title,project) VALUES ('${id(50)}','Diagram','p'),('${id(51)}','Child diagram','p');
      INSERT INTO canvas_notes(canvas_id,note_id) VALUES ('${id(50)}','${id(1)}');
      INSERT INTO canvas_nodes(id,canvas_id,ref_type,ref_id) VALUES
        ('${id(52)}','${id(50)}','content_item','${id(11)}'),('${id(53)}','${id(50)}','note','${id(2)}');
      INSERT INTO canvas_edges(id,canvas_id,source_id,target_id,edge_type,label)
        VALUES ('${id(54)}','${id(50)}','${id(52)}','${id(53)}','supports','Evidence');
      INSERT INTO diagram_element_notes(canvas_id,element_id,note_id) VALUES ('${id(50)}','${id(52)}','${id(2)}');
      INSERT INTO canvas_diagrams VALUES ('${id(50)}','{"nodes":[{"id":"${id(52)}"}]}');
      INSERT INTO diagram_drilldowns VALUES ('${id(50)}','${id(52)}','${id(51)}');
      INSERT INTO ai_chat_sessions(id,title,project_id,note_id) VALUES ('${id(60)}','Chat','p','${id(1)}');
      INSERT INTO chat_decisions(id,session_id,text) VALUES ('${id(61)}','${id(60)}','Decision');
      INSERT INTO chat_outputs(id,session_id,title) VALUES ('${id(62)}','${id(60)}','Output');
      INSERT INTO build_specs(id,title,project_id,note_id,chat_output_id,final_pr_url)
        VALUES ('${id(63)}','Build','p','${id(2)}','${id(62)}','https://example.test/pr');
      INSERT INTO use_cases(id,title,project_id,spec_note_id,build_spec_id) VALUES ('${id(70)}','Use Case','p','${id(2)}','${id(63)}');
      INSERT INTO use_case_sources VALUES ('${id(70)}','discover','${id(10)}',now()),('${id(70)}','canvas','${id(50)}',now());
      INSERT INTO use_case_links VALUES ('${id(71)}','${id(70)}','https://example.test/article',now());
      INSERT INTO designs VALUES ('${id(72)}','${id(3)}','${id(1)}','${id(70)}');
      INSERT INTO design_assets VALUES ('${id(72)}','note','${id(2)}','spec',false);
      INSERT INTO project_register_items(id,kind,title,project_id,source_type,source_id,task_id)
        VALUES ('${id(80)}','risk','Risk','p','chat_decision','${id(61)}','t'),
        ('${id(81)}','question','Question','p','chat_decision','${id(61)}','t'),
        ('${id(82)}','issue','Issue','p','chat_decision','${id(61)}','t');
      INSERT INTO task_links VALUES ('${id(90)}','t','document','owner/repo::spec.md',now()),
        ('${id(91)}','t','spark','${id(40)}',now()),('${id(92)}','t','url','https://example.test/article',now());
      INSERT INTO note_extractions VALUES ('${id(93)}','${id(1)}','spark','${id(41)}','spark',now());
      INSERT INTO semantic_edges(id,from_kind,from_id,to_kind,to_id,relationship,origin)
        VALUES ('${id(94)}','decision','${id(61)}','source','content_item:${id(11)}','supported_by','user_confirmed'),
        ('${id(95)}','decision','${id(61)}','source','note:${id(2)}','supported_by','explicit');
      INSERT INTO note_links(source_note_id,target_note_id) VALUES ('${id(1)}','${id(2)}');
      INSERT INTO note_entity_links(source_note_id,target_type,target_id) VALUES
        ('${id(1)}','diagram','${id(50)}'),('${id(1)}','article','${id(10)}'),('${id(1)}','usecase','${id(70)}'),
        ('${id(1)}','spark','${id(41)}'),('${id(1)}','task','t'),('${id(1)}','project','p'),
        ('${id(1)}','person','${id(21)}'),('${id(1)}','company','${id(20)}');
      INSERT INTO nodes VALUES ('${id(100)}','note','${id(1)}'),('${id(101)}','document','${id(11)}'),
        ('${id(102)}','note','${id(4)}'),('${id(103)}','document','${id(17)}');
      INSERT INTO edges(id,source_node_id,target_node_id,edge_type) VALUES
        ('${id(104)}','${id(100)}','${id(101)}','thematically_related'),
        ('${id(105)}','${id(100)}','${id(101)}','tag_overlap'),
        ('${id(106)}','${id(100)}','${id(101)}','on_map'),
        ('${id(107)}','${id(100)}','${id(102)}','thematically_related');
    `);
    const graph = (seed?: string, depth = '2', inferred = 'false') => readGraphAtlas(db, parseAtlasQuery({
      days: '3650', ...(seed && { seed }), depth, include_inferred: inferred,
    }), now);
    const edge = (g: Awaited<ReturnType<typeof graph>>, source: string, target: string, type: string) =>
      g.edges.find(e => e.source === source && e.target === target && e.edgeType === type);

    await t.test('all live record kinds and declared links resolve without an indexing sweep', async () => {
      const g = await graph();
      const expected = [
        ['note', 1, 'note', 2, 'references'], ['note', 1, 'canvas', 50, 'mentions'],
        ['note', 1, 'discover_item', 10, 'mentions'], ['note', 1, 'usecase', 70, 'mentions'],
        ['note', 1, 'person', 21, 'mentions'], ['note', 1, 'company', 20, 'mentions'],
        ['note', 1, 'spark', 41, 'mentions'],
        ['canvas', 50, 'note', 1, 'on_map'], ['canvas', 50, 'document', 11, 'on_map'],
        ['canvas', 50, 'note', 2, 'annotates'], ['canvas', 50, 'canvas', 51, 'drills_into'],
        ['document', 11, 'note', 2, 'supports'], ['usecase', 70, 'discover_item', 10, 'derived_from'],
        ['usecase', 70, 'note', 2, 'specifies'], ['usecase', 70, 'build_spec', 63, 'implements'],
        ['note', 3, 'note', 2, 'has_asset'], ['note', 3, 'canvas', 50, 'has_asset'],
        ['spark', 41, 'discover_item', 10, 'has_spark'], ['spark', 41, 'spark_theme', 40, 'belongs_to'],
        ['spark', 41, 'note', 2, 'developed_into'], ['spark_theme', 40, 'note', 2, 'developed_into'],
        ['chat', 60, 'note', 1, 'references'], ['chat_output', 62, 'chat', 60, 'recorded_in'],
        ['build_spec', 63, 'note', 2, 'derived_from'], ['build_spec', 63, 'chat_output', 62, 'derived_from'],
        ['build_spec', 63, 'pull_request', 12, 'implements'], ['note', 1, 'spark', 41, 'derived_into'],
        ['decision', 61, 'document', 11, 'supported_by'], ['decision', 61, 'note', 2, 'supported_by'],
      ] as const;
      for (const [a, ai, b, bi, type] of expected) assert.ok(edge(g, `${a}:${id(ai)}`, `${b}:${id(bi)}`, type), `${a} -> ${b} (${type})`);
      for (const [type, n] of [['risk', 80], ['question', 81], ['register_issue', 82]] as const) {
        assert.ok(edge(g, `${type}:${id(n)}`, 'task:t', 'affects'));
        assert.ok(edge(g, `${type}:${id(n)}`, `decision:${id(61)}`, 'affects'));
      }
      assert.ok(edge(g, `note:${id(1)}`, 'task:t', 'mentions'));
      assert.ok(edge(g, `note:${id(1)}`, 'project:p', 'mentions'));
      for (const target of [`document:${id(11)}`, `spark_theme:${id(40)}`, `discover_item:${id(10)}`]) assert.ok(edge(g, 'task:t', target, 'references'));
      for (const source of [`note:${id(1)}`, `discover_item:${id(10)}`, 'task:t', `document:${id(11)}`, `email:${id(13)}`, `cfp_item:${id(19)}`]) {
        assert.ok(edge(g, source, `tag:${id(30)}`, 'tagged_with'), source);
      }
      for (const type of ['meeting', 'blog_post', 'podcast_episode']) assert.ok(g.nodes.some(n => n.refType === type), type);
      assert.equal(new Set(g.nodes.map(n => n.id)).size, g.nodes.length);
      const ids = new Set(g.nodes.map(n => n.id));
      assert.ok(g.edges.every(e => ids.has(e.source) && ids.has(e.target)));
      assert.ok(!g.nodes.some(n => n.id === `note:${id(4)}` || n.refId === id(17) || n.refId === id(18)));
      assert.ok(!g.edges.some(e => e.edgeType === 'tag_overlap' || e.origin === 'inferred'));
      assert.equal(g.nodes.find(n => n.id === `decision:${id(61)}`)?.url, `/chat?session=${id(60)}`);
      assert.equal(g.nodes.find(n => n.id === `chat_output:${id(62)}`)?.url, `/chat?session=${id(60)}`);
      assert.equal(g.nodes.find(n => n.id === `document:${id(11)}`)?.url, 'https://example.test/doc');
      assert.equal(g.nodes.find(n => n.id === `note:${id(1)}`)?.url, null);
      assert.deepEqual(g.nodes.find(n => n.id === `note:${id(1)}`)?.tags, ['Agentic']);
      assert.equal(g.nodes.find(n => n.id === `note:${id(1)}`)?.conceptParent, 'AI');
      assert.equal((await graph(`diagram:${id(50)}`, '1')).rootId, `canvas:${id(50)}`);
      assert.equal((await graph(id(100), '1')).rootId, `note:${id(1)}`);
      assert.equal((await graph(`source:content_item:${id(17)}`, '1')).rootId, `note:${id(2)}`);
    });

    await t.test('frequent tags and direct recorded neighbours survive the node cap and inferred opt-in', async () => {
      await raw.exec(`INSERT INTO notes(id,content) SELECT gen_random_uuid(),'{"title":"Tagged note"}' FROM generate_series(1,510);
        INSERT INTO note_tags SELECT id,'${id(30)}','auto' FROM notes WHERE content='{"title":"Tagged note"}';`);
      const g = await graph(`note:${id(1)}`);
      assert.ok(g.stats.truncated);
      assert.ok(g.nodes.length <= 500 && g.edges.length <= 2500);
      assert.equal(g.nodes.find(n => n.id === `note:${id(1)}`)?.conceptParent, 'AI');
      assert.ok(edge(g, `note:${id(1)}`, `tag:${id(30)}`, 'tagged_with'));
      assert.ok(edge(g, `note:${id(1)}`, `canvas:${id(50)}`, 'mentions'));
      assert.ok((await graph(`note:${id(1)}`, '1', 'true')).edges.some(e => e.origin === 'inferred'));
    });

    await t.test('removed memberships and relationships disappear even when cached edges remain', async () => {
      await raw.exec(`DELETE FROM note_tags WHERE note_id='${id(1)}';
        DELETE FROM note_entity_links WHERE source_note_id='${id(1)}';
        DELETE FROM task_links;
        DELETE FROM canvas_notes;
        DELETE FROM diagram_element_notes;
        UPDATE canvas_diagrams SET document='{"nodes":[]}';
        INSERT INTO design_assets VALUES ('${id(72)}','canvas','${id(50)}','diagram',true);
        UPDATE canvases SET deleted_at=now() WHERE id='${id(51)}';`);
      const g = await graph('project:p');
      assert.ok(!edge(g, `note:${id(1)}`, `tag:${id(30)}`, 'tagged_with'));
      assert.ok(!g.edges.some(e => e.edgeType === 'tag_overlap' || e.id.startsWith('task-link:') || e.id.startsWith('diagram-child:')));
      assert.ok(!edge(g, `canvas:${id(50)}`, `note:${id(1)}`, 'on_map'));
      assert.ok(!edge(g, `note:${id(3)}`, `canvas:${id(50)}`, 'has_asset'));
      assert.ok(!g.nodes.some(n => n.id === `canvas:${id(51)}`));
    });
  } finally { await raw.close(); }
});
