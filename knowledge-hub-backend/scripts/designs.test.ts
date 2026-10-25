import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, mock } from 'node:test';
import JSZip from 'jszip';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { env } from '../src/config/env.js';
import { getFoundryClient } from '../src/ai/foundryClient.js';
import { GitHubClient } from '../src/integrations/github/githubClient.js';
import { assetRole, attachAsset, detachAsset, getDesign, listDesigns, parseAsset, selectDesignAsset } from '../src/designs/designStore.js';
import { collaboration, digest, parseBlueprint, parseChanges, queueFeedback, renderArtifact, resolveProposal, proposeFeedback, sameSources, sourceSnapshot } from '../src/designs/designArtifacts.js';
import { createPackage, packageArchive, preparePublication, publishPackage, validateDiagramSvg } from '../src/designs/designPackages.js';
import { authoredTarget, parseAuthored, renderAuthored, selectionBelongs } from '../src/designs/visualArtifact.js';
import { DESIGN_CHAT_TOOLS, executeDesignTool, type DesignTurnState } from '../src/ai/designTools.js';

const ROOT = 'b028adff-5851-4203-915f-67f2ab889433';
const SPEC = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const writing = (title: string, contentType: string, text: string): string =>
  JSON.stringify({ title, contentType, contentJson: JSON.stringify([{ id: 'body', type: 'paragraph', content: [{ type: 'text', text, styles: { bold: true } }], children: [] }]) });
const blueprint = {
  title: 'Claims journey', explanation: 'Explore the evidence-led journey', openDecisions: [],
  elements: [
    { id: 'entry', kind: 'screen', title: 'Start claim', content: 'Review before submitting', sourceIds: [ROOT, SPEC], choices: ['Manual review'],
      components: [{ kind: 'field', label: 'Claim reference', detail: 'Reference', targetId: null }, { kind: 'button', label: 'Review', detail: '', targetId: 'review' }] },
    { id: 'review', kind: 'screen', title: 'Review claim', content: 'Evidence and next steps', sourceIds: [SPEC], choices: [],
      components: [{ kind: 'card', label: 'Evidence', detail: 'Verify the claim evidence', targetId: null }, { kind: 'button', label: 'Back', detail: '', targetId: 'entry' }] },
  ],
};

test('authored visuals are sanitised and must explain purpose, actors, an example and decisions', () => {
  const sources = [{ id: ROOT }, { id: SPEC }];
  const body = `<section data-element="how" onclick="steal()"><h1>How it works</h1><script>steal()</script><a href="javascript:steal()">link</a>
<svg viewBox="0 0 400 80" onload="steal()"><defs><marker id="arrow"><path d="M0 0L6 3L0 6z"/></marker></defs>
<g data-actor="athena"><rect width="120" height="40" style="fill:url(https://evil.example/x)"/><text x="10" y="24">Athena drafts</text></g>
<g data-actor="you"><rect x="200" width="120" height="40"/><text x="210" y="24">You approve</text></g><line x1="120" y1="20" x2="200" y2="20" marker-end="url(#arrow)"/></svg>
<ol><li data-actor="athena">Athena drafts the post.</li><li data-actor="you">You approve the exact text.</li></ol></section>
<section data-element="example"><h2>Example</h2><div data-walkthrough><div data-step="draft" data-step-title="Draft"><p>Athena drafts.</p><button data-goto="approve">Open draft</button><button>Publish now</button></div>
<div data-step="approve" data-step-title="Approve"><p>You approve.</p><input value="x"></div></div></section>`;
  const raw = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ title: 'Publishing', purpose: 'Athena drafts posts; you approve them.', ask: 'Answer 1 decision.', body,
    regions: [{ id: 'how', title: 'How it works', role: 'flow', sourceIds: [SPEC] }, { id: 'example', title: 'Example', role: 'example', sourceIds: [SPEC] }],
    decisions: [{ id: 'landing', question: 'Where should approval start?', context: 'Sets the first screen.', recommended: 'Today',
      options: [{ label: 'Today', consequence: 'Athena shows pending approvals on Today.' }, { label: 'Discover', consequence: 'Approvals stay in Discover.' }], sourceIds: [SPEC] }], ...overrides });
  const { blueprint, removed } = parseAuthored(raw(), sources);
  assert.ok(removed >= 5);
  assert.ok(!/<script|onclick|onload|javascript:|evil\.example|<input|<a /.test(blueprint.body));
  assert.match(blueprint.body, /<h2>How it works<\/h2>/);
  assert.match(blueprint.body, /<button data-goto="approve">Open draft<\/button>/);
  assert.match(blueprint.body, /<span class="mock-button">Publish now<\/span>/);
  assert.match(blueprint.body, /marker-end="url\(#arrow\)"/);
  assert.deepEqual(blueprint.openDecisions, ['Where should approval start?']);
  assert.ok(selectionBelongs(authoredTarget(blueprint, 'how')!.text, 'Athena drafts the  post.'));
  assert.ok(!selectionBelongs(authoredTarget(blueprint, 'how')!.text, 'Something else'));
  assert.equal(authoredTarget(blueprint, 'landing')?.decision?.id, 'landing');
  const html = renderAuthored(blueprint, ROOT, 2);
  assert.match(html, /What I need from you:/);
  assert.match(html, /Go to the 1 decision/);
  assert.match(html, /Athena recommends/);
  assert.match(html, /connect-src 'none'/);
  assert.equal((html.match(/<script/g) ?? []).length, 2);
  assert.throws(() => parseAuthored(raw({ regions: [{ id: 'how', title: 'How', role: 'flow', sourceIds: [SPEC] }] }), sources), /undeclared region/);
  assert.throws(() => parseAuthored(raw({ body: body.replace('data-actor="you"', 'data-actor="athena"').replace('<li data-actor="you">', '<li>') }), sources), /automatic \(athena\) and human/);
  assert.throws(() => parseAuthored(raw({ body: body.replace('<div data-step="approve" data-step-title="Approve">', '<div>') }), sources), /at least two/);
  assert.throws(() => parseAuthored(raw({ decisions: [{ id: 'x', question: 'Q', context: '', recommended: 'Maybe', options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], sourceIds: [SPEC] }] }), sources), /does not offer/);
  assert.throws(() => parseAuthored(raw({ body: `${body}<p>STATE_AWAITING_APPROVAL_V2</p>` }), sources), /internal state/);
});

test('visual contracts reject unsafe types, ambiguous targets and overlapping anchors', () => {
  assert.equal(assetRole('spec'), 'spec');
  assert.throws(() => parseAsset({ sourceType: 'canvas', sourceId: OTHER, role: 'spec' }), /does not belong/);
  assert.throws(() => parseAsset({ sourceType: 'link', sourceId: 'javascript:alert(1)', role: 'reference' }), /HTTP/);
  const sources = [{ id: ROOT, role: 'use_case', title: 'Original', revision: 1, markdown: 'Original',
    blocks: [{ id: 'body', type: 'paragraph', content: 'Original', children: [{ id: 'child', type: 'paragraph', content: 'Preserved' }] }] },
  { id: SPEC, role: 'spec', title: 'Spec', revision: 1, markdown: 'Spec', blocks: [] }];
  const visual = parseBlueprint(JSON.stringify(blueprint), sources);
  const html = renderArtifact(visual, ROOT, 1);
  assert.match(html, /data-view="entry"/);
  assert.match(html, /data-view="review"/);
  assert.match(html, /<input placeholder="Reference"/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /data-annotate/);
  const hostile = parseBlueprint(JSON.stringify({ ...blueprint, title: '<script>steal()</script>' }), sources);
  assert.ok(!renderArtifact(hostile, ROOT, 1).includes('<script>steal()'));
  assert.throws(() => parseBlueprint(JSON.stringify({ ...blueprint, elements: [{ ...blueprint.elements[0], sourceIds: [OTHER] }] }), sources), /source mapping/);
  assert.throws(() => parseChanges(JSON.stringify({ explanation: 'Unsafe', changes: [{ noteId: OTHER, blockId: null, markdown: 'Injected' }] }), sources, new Set([ROOT])), /unlinked/);
  assert.throws(() => parseChanges(JSON.stringify({ explanation: 'Overlap', changes: [
    { noteId: ROOT, blockId: 'body', markdown: 'Parent' }, { noteId: ROOT, blockId: 'child', markdown: 'Child' },
  ] }), sources, new Set([ROOT])), /Overlapping/);
  assert.ok(parseChanges(JSON.stringify({ explanation: 'New requirement without matching prose', changes: [{ noteId: ROOT, blockId: null, markdown: '- Require explicit approval' }] }), sources, new Set([ROOT])).changes[0]?.after.length);
  validateDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" width="20" height="20"/></svg>');
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>',
  ]) assert.throws(() => validateDiagramSvg(svg));
});

test('source comparison ignores JSONB object key order but rejects actual writing and revision changes', () => {
  const source = { id: ROOT, role: 'spec', revision: 1, title: 'Spec', markdown: 'Original', blocks: [{ id: 'body', type: 'paragraph', content: 'Original' }] };
  const stored = { blocks: [{ content: 'Original', type: 'paragraph', id: 'body' }], markdown: 'Original', title: 'Spec', revision: 1, role: 'spec', id: ROOT };
  assert.equal(sameSources([source], [stored]), true);
  assert.equal(sameSources([source], [{ ...stored, revision: 2 }]), false);
  assert.equal(sameSources([source], [{ ...stored, markdown: 'Edited' }]), false);
});

test('source section correction preserves originals and existing explicit non-use-case assignments', async () => {
  const local = new PGlite();
  try {
    await local.exec(`
      CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT);
      CREATE TABLE designs(id UUID PRIMARY KEY,source_note_id UUID,selections JSONB DEFAULT '{}',
        revision INTEGER DEFAULT 1,updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE design_assets(design_id UUID,source_type TEXT,source_id TEXT,role TEXT,excluded BOOLEAN,
        PRIMARY KEY(design_id,source_type,source_id));
    `);
    await local.query('INSERT INTO notes VALUES($1,$2)', [ROOT, writing('Client Report Assurance', 'use-case', 'High fidelity prototype specification')]);
    await local.query('INSERT INTO designs(id,source_note_id,selections) VALUES($1,$1,$2)', [ROOT, JSON.stringify({ use_case: ROOT })]);
    const sql = await readFile(new URL('../src/db/migrations/106_design_source_sections.sql', import.meta.url), 'utf8');
    await local.exec(sql);
    const { rows } = await local.query<{ role: string; selections: Record<string, string> }>(
      'SELECT a.role,d.selections FROM designs d JOIN design_assets a ON a.design_id=d.id');
    assert.equal(rows[0]?.role, 'spec');
    assert.deepEqual(rows[0]?.selections, {});
    assert.equal((await local.query<{ content: string }>('SELECT content FROM notes')).rows[0]?.content,
      writing('Client Report Assurance', 'use-case', 'High fidelity prototype specification'));
    await local.exec("UPDATE design_assets SET role='architecture'");
    await local.exec(sql);
    assert.equal((await local.query<{ role: string }>('SELECT role FROM design_assets')).rows[0]?.role, 'architecture');
  } finally { await local.close(); }
});

test('real parent conversion, source identity, persisted feedback, atomic acceptance and byte-identical coherent handoff', async () => {
  const local = new PGlite();
  await local.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE notes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),content TEXT NOT NULL,status TEXT DEFAULT 'active',
      project_id TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),
      tags TEXT[] DEFAULT '{}',linked_items UUID[] DEFAULT '{}');
    CREATE TABLE use_cases(id UUID PRIMARY KEY,title TEXT,summary TEXT,project_id TEXT,stage TEXT,spec_note_id UUID,updated_at TIMESTAMPTZ);
    CREATE TABLE use_case_sources(use_case_id UUID,source_type TEXT,source_id TEXT);
    CREATE TABLE canvases(id UUID PRIMARY KEY,title TEXT,project TEXT,canvas_type TEXT,deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE canvas_diagrams(canvas_id UUID PRIMARY KEY,revision INTEGER,document JSONB);
    CREATE TABLE canvas_notes(canvas_id UUID,note_id TEXT);
    CREATE TABLE diagram_element_notes(canvas_id UUID,note_id TEXT);
    CREATE TABLE ai_chat_sessions(id UUID PRIMARY KEY,note_id TEXT,from_think BOOLEAN,project_id TEXT,title TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX session_note ON ai_chat_sessions(note_id) WHERE note_id IS NOT NULL;
    CREATE TABLE ai_chat_messages(id BIGSERIAL,session_id UUID,role TEXT,content TEXT);
  `);
  for (const file of ['060_note_history.sql', '061_note_github_publications.sql', '064_note_list_metadata.sql', '082_note_links.sql', '102_designs.sql', '103_design_note_origins.sql']) {
    await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const original = writing('Claims', 'use-case', 'Original requirement');
  await local.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4)', [ROOT, original, SPEC, writing('Claims spec', 'spec', 'Original specification')]);
  for (const file of ['104_design_note_artifacts.sql', '105_design_note_parent_trigger.sql']) await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  let failSecondWrite = false;
  const query = async (sql: string, values?: unknown[]) => {
    if (failSecondWrite && sql.includes('UPDATE notes SET content') && values?.[0] === ROOT) throw new Error('Injected second-source failure');
    const result = await local.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const queryMock = mock.method(getDb(), 'query', query);
  const connectionMock = mock.method(getDb(), 'connect', async () => ({ query, release() {} }));
  let modelCalls = 0;
  const modelMock = mock.method(getFoundryClient('design-feedback'), 'chatBulk', async () => {
    modelCalls++;
    return JSON.stringify({ explanation: 'Add explicit approval without losing original context', visual: blueprint, changes: [
      { noteId: ROOT, blockId: 'body', markdown: '**Revised requirement**' },
      { noteId: SPEC, blockId: 'body', markdown: 'Revised specification with [evidence](https://example.com)' },
    ] });
  });
  try {
    const listed = await listDesigns(getDb());
    assert.equal(listed.items.length, 1);
    assert.notEqual(listed.items[0]!.parentNoteId, ROOT);
    let design = await getDesign(getDb(), ROOT);
    assert.equal(design.sourceNoteId, ROOT);
    assert.equal((await local.query('SELECT content FROM notes WHERE id=$1', [ROOT])).rows[0]?.content, original);
    assert.equal((await local.query('SELECT count(*) AS n FROM notes')).rows[0]?.n, 3);
    design = await attachAsset(getDb(), design.parentNoteId, { sourceType: 'note', sourceId: SPEC, role: 'spec' });
    assert.equal(design.assets.find(asset => asset.sourceId === SPEC)?.role, 'spec');
    await assert.rejects(attachAsset(getDb(), design.id, { sourceType: 'note', sourceId: design.parentNoteId, role: 'spec' }), /cannot link itself/);
    await assert.rejects(detachAsset(getDb(), design.id, { sourceType: 'note', sourceId: ROOT }), /original source note remains linked/);
    await assert.rejects(selectDesignAsset(getDb(), design.id, { role: 'spec', sourceId: SPEC, expectedRevision: 0 }), /changed/);
    design = await selectDesignAsset(getDb(), design.id, { role: 'spec', sourceId: SPEC, expectedRevision: design.revision });
    const populated = writing('Populated', 'note', 'Never lose this writing');
    await local.query('INSERT INTO notes(id,content) VALUES($1,$2)', [OTHER, populated]);
    const converted = { ...JSON.parse(populated), contentType: 'design' };
    await local.query('UPDATE notes SET content=$2 WHERE id=$1', [OTHER, JSON.stringify(converted)]);
    const real = await getDesign(getDb(), OTHER);
    assert.equal(real.parentNoteId, OTHER, 'type changes preserve the original ID');
    assert.equal(JSON.parse(String((await local.query('SELECT content FROM notes WHERE id=$1', [OTHER])).rows[0]?.content)).contentJson, JSON.parse(populated).contentJson);

    const sources = await sourceSnapshot(getDb(), design);
    const visual = parseBlueprint(JSON.stringify(blueprint), sources);
    const artifactId = randomUUID();
    await local.query('INSERT INTO design_artifacts(id,design_id,revision,sources,blueprint,html) VALUES($1,$2,1,$3,$4,$5)',
      [artifactId, design.id, JSON.stringify(sources), JSON.stringify(visual), renderArtifact(visual, artifactId, 1)]);
    const feedbackInput = { requestId: randomUUID(), artifactId, elementId: 'entry', selection: '', instruction: '  Require approval before submission.  ' };
    const feedback = await queueFeedback(getDb(), design.id, feedbackInput);
    assert.equal(feedback.instruction, feedbackInput.instruction, 'retain exact user input');
    assert.equal((await queueFeedback(getDb(), design.id, feedbackInput)).id, feedback.id);
    await assert.rejects(queueFeedback(getDb(), design.id, { ...feedbackInput, instruction: 'Changed retry' }), /different input/);
    const before = await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[ROOT, SPEC]]);
    const proposal = await proposeFeedback(getDb(), design.id);
    assert.equal(modelCalls, 1);
    assert.deepEqual((await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[ROOT, SPEC]])).rows, before.rows, 'proposing never writes sources');
    await assert.rejects(proposeFeedback(getDb(), design.id), /existing proposal|Queue feedback/);
    assert.equal(modelCalls, 1);
    assert.equal((await local.query("SELECT count(*) AS n FROM ai_chat_messages WHERE role='user'")).rows[0]?.n, 1, 'feedback reaches the existing Athena conversation exactly once');
    await local.query('UPDATE notes SET revision=revision+1 WHERE id=$1', [SPEC]);
    await assert.rejects(resolveProposal(getDb(), design.id, proposal.id, true), /changed|stale/i);
    await local.query('UPDATE notes SET revision=revision-1 WHERE id=$1', [SPEC]);
    failSecondWrite = true;
    await assert.rejects(resolveProposal(getDb(), design.id, proposal.id, true), /second-source failure/);
    assert.deepEqual((await local.query('SELECT id,content,revision FROM notes WHERE id=ANY($1::uuid[]) ORDER BY id', [[ROOT, SPEC]])).rows, before.rows, 'failed multi-source acceptance rolls back every original');
    assert.equal((await local.query("SELECT status FROM design_proposals WHERE id=$1", [proposal.id])).rows[0]?.status, 'pending');
    failSecondWrite = false;
    await resolveProposal(getDb(), design.id, proposal.id, true);
    const accepted = await collaboration(getDb(), design.id);
    assert.equal(accepted.feedback[0]?.status, 'accepted');
    assert.equal(accepted.artifact?.revision, 2, 'accepted Markdown and revised artifact commit together');
    assert.equal(accepted.stale, false);
    assert.equal((await local.query('SELECT count(*) AS n FROM note_versions WHERE note_id=ANY($1::uuid[])', [[ROOT, SPEC]])).rows[0]?.n, 2, 'both originals have history checkpoints');
    const secondFeedback = await queueFeedback(getDb(), design.id, { ...feedbackInput, requestId: randomUUID(), artifactId: accepted.artifact!.id });
    const discarded = await proposeFeedback(getDb(), design.id);
    const beforeDiscard = (await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows;
    await resolveProposal(getDb(), design.id, discarded.id, false);
    assert.deepEqual((await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows, beforeDiscard);
    assert.equal((await local.query('SELECT status FROM design_feedback WHERE id=$1', [secondFeedback.id])).rows[0]?.status, 'discarded');

    const snapshot = await createPackage(getDb(), design.id, {});
    assert.equal(snapshot.manifest.ready, false);
    assert.ok(snapshot.manifest.missingInputs.includes('architecture'));
    assert.ok(snapshot.files['use-case.md']?.includes('Revised requirement'));
    assert.ok(snapshot.files['specification.md']?.includes('[evidence](https://example.com)'));
    assert.ok(snapshot.files['visual-design.html']?.includes('data-view="review"'));
    assert.match(snapshot.files['README.md']!, /Pending or discarded feedback is NOT an accepted requirement/);
    const archive = await JSZip.loadAsync(await packageArchive(snapshot));
    for (const file of snapshot.manifest.files) {
      const bytes = await archive.file(`design/${file.path}`)!.async('string');
      assert.equal(bytes, snapshot.files[file.path]);
      assert.equal(digest(bytes), file.sha256);
    }
    const gh = new GitHubClient();
    let ref = 'base';
    let treeEntries: Array<{ path: string; sha: string; type: string; mode: string }> = [{ path: 'unrelated.md', sha: 'unrelated', type: 'blob', mode: '100644' }];
    let postedFiles: Record<string, string> = {};
    const ghGet = mock.method(gh, 'get', async (path: string) => {
      if (path === '/repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main', permissions: { push: true } };
      if (path.includes('/git/ref/heads/')) return { object: { sha: ref } };
      if (path.endsWith('/git/commits/base')) return { sha: 'base', tree: { sha: 'base-tree' } };
      if (path.includes('/git/trees/')) return { sha: 'tree', truncated: false, tree: treeEntries };
      throw new Error(`Unexpected mocked GET ${path}`);
    });
    const credential = mock.getter(env, 'GITHUB_ACCESS_TOKEN', () => 'fixture-token');
    const ghGetOptional = mock.method(gh, 'getOptional', async (path: string) => {
      if (path === '/repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main', permissions: { push: true } };
      throw new Error(`Unexpected mocked optional GET ${path}`);
    });
    const ghPost = mock.method(gh, 'post', async (path: string, body: { base_tree?: string; tree?: Array<{ path: string; content: string }>; parents?: string[] }) => {
      if (path.endsWith('/git/trees')) {
        assert.equal(body.base_tree, 'base-tree');
        postedFiles = Object.fromEntries(body.tree!.map(file => [file.path.replace(/^design\//, ''), file.content]));
        treeEntries = [...treeEntries, ...body.tree!.map(file => ({ path: file.path, sha: createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0`).update(file.content).digest('hex'), type: 'blob', mode: '100644' }))];
        return { sha: 'new-tree' };
      }
      assert.deepEqual(body.parents, ['base']);
      return { sha: 'published-commit' };
    });
    let patches = 0;
    const ghPatch = mock.method(gh, 'patch', async (_: string, body: { sha: string; force: boolean }) => { assert.equal(body.force, false); ref = body.sha; patches++; return { object: { sha: ref } }; });
    try {
      await assert.rejects(preparePublication(getDb(), design.id, snapshot.id, { repo: 'owner/repo', folder: '../escape' }, gh));
      const publication = await preparePublication(getDb(), design.id, snapshot.id, { repo: 'owner/repo', folder: 'design' }, gh);
      await assert.rejects(publishPackage(getDb(), design.id, snapshot.id, publication.id, false, gh), /Confirm/);
      ref = 'changed';
      await assert.rejects(publishPackage(getDb(), design.id, snapshot.id, publication.id, true, gh), /changed/);
      assert.equal(patches, 0);
      ref = 'base';
      const result = await publishPackage(getDb(), design.id, snapshot.id, publication.id, true, gh);
      assert.match(result.commitUrl, /published-commit$/);
      assert.deepEqual(postedFiles, snapshot.files, 'download and GitHub receive the same immutable bytes');
      assert.ok(treeEntries.some(entry => entry.path === 'unrelated.md'));
      assert.equal(patches, 1);
      await publishPackage(getDb(), design.id, snapshot.id, publication.id, true, gh);
      assert.equal(patches, 1, 'retry verifies the prior commit without republishing');
    } finally { credential.mock.restore(); ghGet.mock.restore(); ghGetOptional.mock.restore(); ghPost.mock.restore(); ghPatch.mock.restore(); }

    assert.deepEqual(DESIGN_CHAT_TOOLS.map(tool => tool.function.name), ['read_design_package', 'save_design_documents']);
    const chatState: DesignTurnState = { changedNoteIds: [] };
    const owner = design.parentNoteId;
    await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {}, {}, chatState), /Read the current Design/);
    await assert.rejects(executeDesignTool(getDb(), 'read_design_package', owner, {}, { excludedIds: new Set([ROOT]) }, chatState), /excluded/);
    await executeDesignTool(getDb(), 'read_design_package', owner, {}, {}, chatState);
    const source = chatState.read!.sources.find(item => item.id === ROOT)!;
    const count = (await local.query<{ n: number }>('SELECT count(*)::int AS n FROM notes')).rows[0]!.n;
    const documents = [
      { role: 'use_case', noteId: ROOT, expectedRevision: source.revision, title: source.title,
        markdown: null, changes: [{ blockId: 'body', markdown: '**Clarified goal and user journey**' }] },
      { role: 'architecture', noteId: null, expectedRevision: null, title: 'Claims architecture',
        markdown: '# Claims architecture\n\nPreserve the linked sources.', changes: [] },
    ];
    const request = { expectedDesignRevision: chatState.read!.revision, documents };
    await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {
      ...request, documents: [{ ...documents[0], noteId: OTHER }],
    }, {}, chatState), /identity changed/);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await executeDesignTool(getDb(), 'save_design_documents', owner, request, {}, chatState);
      assert.equal((await local.query<{ n: number }>('SELECT count(*)::int AS n FROM notes')).rows[0]!.n, count + 1,
        'Only the truly missing section creates a new note');
      const current = await getDesign(getDb(), owner);
      assert.equal(current.assets.find(asset => asset.role === 'use_case')!.sourceId, ROOT, 'Existing original stays authoritative');
      assert.equal(current.assets.filter(asset => asset.role === 'architecture').length, 1);
      assert.ok(current.selections.architecture);
      assert.equal(chatState.changedNoteIds.length, 2);
      assert.equal(chatState.read, undefined, 'Another save must read the new revisions');
      const history = await local.query<{ reason: string }>("SELECT reason FROM note_versions WHERE note_id=$1 ORDER BY created_at DESC LIMIT 1", [ROOT]);
      assert.equal(history.rows[0]?.reason, 'before_athena');

      await executeDesignTool(getDb(), 'read_design_package', owner, {}, {}, chatState);
      const beforeFailure = (await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows;
      const changedSources = chatState.read!.sources.filter(item => item.role === 'use_case' || item.role === 'spec');
      failSecondWrite = true;
      await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {
        expectedDesignRevision: chatState.read!.revision, documents: changedSources.map(item => ({
          role: item.role, noteId: item.id, expectedRevision: item.revision, title: item.title, markdown: 'Must roll back', changes: [],
        })),
      }, {}, chatState), /Injected second-source failure/);
      failSecondWrite = false;
      assert.deepEqual((await local.query('SELECT id,content,revision FROM notes ORDER BY id')).rows, beforeFailure);
      await local.query('UPDATE notes SET revision=revision+1 WHERE id=$1', [SPEC]);
      await assert.rejects(executeDesignTool(getDb(), 'save_design_documents', owner, {
        expectedDesignRevision: chatState.read!.revision, documents: [{
          role: 'use_case', noteId: ROOT, expectedRevision: changedSources.find(item => item.id === ROOT)!.revision,
          title: source.title, markdown: 'Reject stale context', changes: [],
        }],
      }, {}, chatState), /source changed/);
    } finally { failSecondWrite = false; mock.timers.reset(); }
  } finally { modelMock.mock.restore(); queryMock.mock.restore(); connectionMock.mock.restore(); await local.close(); }
});
