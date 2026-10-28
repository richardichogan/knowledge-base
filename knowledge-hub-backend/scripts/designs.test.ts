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
import { assetDesigns, assetRole, attachAsset, DESIGN_NOTE_MEMBERSHIPS_SQL, detachAsset, getDesign, listDesigns, parseAsset, selectDesignAsset, setSpecificationType } from '../src/designs/designStore.js';
import { writeDesignSpec } from '../src/designs/designSpec.js';
import { demoSpecificationForm, demoSpecificationResponseSchema } from '../src/ai/demoSpecification.js';
import { AiError } from '../src/types/errors.js';
import { collaboration, designModelContext, MAX_DESIGN_MODEL_CONTEXT, digest, parseBlueprint, parseChanges, queueFeedback, renderArtifact, resolveProposal, proposeFeedback, sameSources, sourceSnapshot } from '../src/designs/designArtifacts.js';
import { createPackage, packageArchive, preparePublication, publishPackage, validateDiagramSvg } from '../src/designs/designPackages.js';
import { AUTHORING_CONTRACT, authoredForModel, authoredTarget, parseAuthored, renderAuthored, selectionBelongs } from '../src/designs/visualArtifact.js';
import { DESIGN_CHAT_TOOLS, executeDesignTool, type DesignTurnState } from '../src/ai/designTools.js';
import { validateConsistencyFindings } from '../src/designs/designConsistency.js';

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

test('consistency findings require exact source quotations and cross-source contradictions', () => {
  const sources = [
    { id: ROOT, role: 'use_case', revision: 1, title: 'Use case', markdown: 'A human approves each payment.', blocks: [] },
    { id: SPEC, role: 'spec', revision: 2, title: 'Spec', markdown: 'Payments are approved automatically.', blocks: [] },
    { id: OTHER, role: 'diagram', revision: 3, title: 'Flow', markdown: '', blocks: [], document: {
      nodes: [{ id: 'human', label: 'Human approval', description: 'Check the payment.' }], edges: [],
    } },
  ];
  const evidence = [{ sourceId: ROOT, quote: 'A human approves each payment.', elementId: null },
    { sourceId: SPEC, quote: 'Payments are approved automatically.', elementId: null }];
  const finding = { kind: 'contradiction', explanation: 'Approval ownership conflicts.', evidence };
  assert.equal(validateConsistencyFindings({ findings: [finding] }, sources).length, 1);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...finding, evidence: [evidence[0]] }] }, sources), /two different/);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...finding, evidence: [{ ...evidence[0], quote: 'Invented quote' }, evidence[1]] }] }, sources), /verified/);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...finding, evidence: [{ sourceId: OTHER, quote: 'Human approval', elementId: 'missing' }, evidence[1]] }] }, sources), /verified/);
  assert.equal(validateConsistencyFindings({ findings: [{ ...finding, evidence: [{ sourceId: OTHER, quote: 'Human approval', elementId: 'human' }, evidence[1]] }] }, sources).length, 1);
  assert.throws(() => validateConsistencyFindings({}, sources), /incomplete/);
  const impact = { kind: 'impact', explanation: 'Revisit the specified approval step if the decision changes.', evidence: [evidence[0]] };
  assert.equal(validateConsistencyFindings({ findings: [impact] }, sources, true)[0]?.kind, 'impact');
  assert.throws(() => validateConsistencyFindings({ findings: [impact] }, sources), /contract/);
  assert.throws(() => validateConsistencyFindings({ findings: [{ ...impact, evidence: [{ ...evidence[0], quote: 'Not in the source' }] }] }, sources, true), /verified/);
  assert.throws(() => validateConsistencyFindings({ findings: [finding] }, sources, true), /contract/);
});

test('authored visuals are sanitised and must explain purpose, actors, an example and decisions', () => {
  const sources = [{ id: ROOT }, { id: SPEC }];
  const body = `<section data-element="how" onclick="steal()"><h1>How it works</h1><script>steal()</script><a href="javascript:steal()">link</a>
<svg viewBox="0 0 400 80" onload="steal()"><defs><marker id="arrow"><path d="M0 0L6 3L0 6z"/></marker></defs>
<g data-actor="automatic" data-actor-label="Athena"><rect width="120" height="40" style="fill:url(https://evil.example/x)"/><text x="10" y="24">Athena drafts</text></g>
<g data-actor="human" data-actor-label="Author"><rect x="200" width="120" height="40"/><text x="210" y="24">You approve</text></g><line x1="120" y1="20" x2="200" y2="20" marker-end="url(#arrow)"/></svg>
<ol><li data-actor="automatic" data-actor-label="Athena">Athena drafts the post.</li><li data-actor="human" data-actor-label="Author">You approve the exact text.</li></ol></section>
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
  assert.throws(() => parseAuthored(raw({ body: body.replace('data-actor="human"', 'data-actor="you"') }), sources), /data-actor must classify/);
  assert.throws(() => parseAuthored(raw({ body: body.replace('<div data-step="approve" data-step-title="Approve">', '<div>') }), sources), /at least two/);
  assert.throws(() => parseAuthored(raw({ decisions: [{ id: 'x', question: 'Q', context: '', recommended: 'Maybe', options: [{ label: 'A', consequence: 'a' }, { label: 'B', consequence: 'b' }], sourceIds: [SPEC] }] }), sources), /does not offer/);
  assert.throws(() => parseAuthored(raw({ body: `${body}<p>STATE_AWAITING_APPROVAL_V2</p>` }), sources), /internal state/);
});

test('IMAGINE Blueprint actors name digital workers and business roles, not the author', () => {
  const body = `<section data-element="flow"><h2>Flow</h2><svg viewBox="0 0 500 200">
<g data-actor="automatic" data-actor-label="Evidence Worker"><title>Evidence Worker</title><rect width="120" height="40"/><text>Evidence Worker checks evidence</text></g>
<g data-actor="automatic" data-actor-label="Close Steward"><title>Close Steward</title><rect y="60" width="120" height="40"/><text>Close Steward presents readiness</text></g>
<g data-actor="human" data-actor-label="Controller"><title>Controller</title><rect x="250" width="120" height="40"/><text>Controller authorises close</text></g>
<g data-actor="system" data-actor-label="Teams"><title>Teams</title><rect x="250" y="60" width="120" height="40"/><text>Teams delivers the interaction</text></g>
</svg><ol><li data-actor="automatic" data-actor-label="Evidence Worker">Evidence Worker checks evidence.</li>
<li data-actor="human" data-actor-label="Controller">Controller authorises close.</li></ol></section>
<section data-element="screens"><h2>Screens</h2><div data-walkthrough>
<div data-step="evidence" data-step-title="Evidence"><p>Evidence Worker produces the readiness pack.</p><button data-goto="approval">Review</button></div>
<div data-step="approval" data-step-title="Approval"><p>Controller reviews the pack in Teams.</p></div></div></section>`;
  const raw = (html = body): string => JSON.stringify({ title: 'Smart Close', purpose: 'Digital workers prepare close evidence for the Controller.',
    ask: 'Review the worker responsibilities.', body: html, decisions: [], regions: [
      { id: 'flow', title: 'Flow', role: 'flow', sourceIds: [SPEC] },
      { id: 'screens', title: 'Screens', role: 'screens', sourceIds: [SPEC] },
    ] });
  const sources = [{ id: SPEC }];
  const { blueprint } = parseAuthored(raw(), sources);
  for (const label of ['Evidence Worker', 'Close Steward', 'Controller', 'Teams']) {
    assert.ok(blueprint.body.includes(`data-actor-label="${label}"`));
  }
  assert.deepEqual(parseAuthored(JSON.stringify(authoredForModel(blueprint)), sources).blueprint, blueprint, 'feedback round trips preserve exact actor labels');
  const html = renderAuthored(blueprint, ROOT, 4);
  assert.match(html, /content:attr\(data-actor-label\)/);
  assert.match(html, /Automatic work/);
  assert.doesNotMatch(html, /Athena does this automatically|Athena · automatic|You decide or approve/);
  assert.throws(() => parseAuthored(raw(body.replace('data-actor="automatic"', 'data-actor="athena"')), sources), /data-actor must classify/);
  assert.doesNotThrow(() => parseAuthored(raw(body.replace(' data-actor-label="Evidence Worker"', '')), sources),
    'a visible actor name does not need duplicate label metadata');
  assert.throws(() => parseAuthored(raw(body.replace(' data-actor-label="Evidence Worker"', '').replace('<title>Evidence Worker</title>', '').replace('<text>Evidence Worker checks evidence</text>', '')), sources), /actor name in a label or visible text/);
  assert.throws(() => parseAuthored(raw(body.replace('data-actor-label="Evidence Worker"', 'data-actor-label=""')), sources), /source actor label/);
  assert.throws(() => parseAuthored(raw(body.replace('data-actor="automatic"', 'data-actor="invented"')), sources), /data-actor must classify/);
  assert.throws(() => parseAuthored(raw(body.replace(/ data-actor="[^"]*"/g, '').replace(/ data-actor-label="[^"]*"/g, '')), sources), /flow must identify/);
  assert.doesNotThrow(() => parseAuthored(raw(body.replace(/data-actor="human"/g, 'data-actor="automatic"')), sources),
    'a source-defined automated flow does not need an invented human gate');
  const escaped = parseAuthored(raw(body.replace('data-actor-label="Evidence Worker"', 'data-actor-label="Evidence &amp; Controls &lt;worker&gt;"')), sources);
  assert.match(escaped.blueprint.body, /data-actor-label="Evidence &amp; Controls &lt;worker&gt;"/);
  const historical = renderAuthored({ ...blueprint, body: blueprint.body.replace(/data-actor="automatic"/g, 'data-actor="athena"').replace(/data-actor="human"/g, 'data-actor="you"') }, ROOT, 3);
  assert.match(historical, /\[data-actor=athena\]/, 'old saved visuals keep actor styling without a database rewrite');
  assert.doesNotMatch(historical, /Athena does this automatically|Athena · automatic/);
  assert.match(AUTHORING_CONTRACT, /Athena is the Blueprint author, not automatically an actor/);
  assert.match(AUTHORING_CONTRACT, /For an IMAGINE specification, name the actual digital workers/);
  assert.match(AUTHORING_CONTRACT, /Correct those everywhere/);
  assert.match(AUTHORING_CONTRACT, /purpose, ask and each decision question ≤ 300/);
  assert.throws(() => parseAuthored(JSON.stringify({ ...JSON.parse(raw()), purpose: 'x'.repeat(301) }), sources), /purpose is missing or too long/);
  assert.doesNotMatch(AUTHORING_CONTRACT, /three horizontal lanes "You", "Athena"|what Athena does middle|If you choose this, Athena will/);
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

test('Blueprint requests retain full large sources once, without changing editable snapshots', () => {
  const markdown = 'Full specification requirement.\n'.repeat(16_000);
  const blocks = [{ id: 'body', type: 'paragraph', content: markdown, children: [
    { id: 'mention', type: 'noteMention', props: { noteId: OTHER } },
    { id: 'image', type: 'image', props: { url: 'https://example.com/evidence.png' } },
  ] }];
  const sources = [
    { id: SPEC, role: 'spec', revision: 5, title: 'Complete spec', markdown, blocks },
    { id: ROOT, role: 'design', revision: 1, title: 'Empty source', markdown: 'Source heading', blocks: [] },
    { id: OTHER, role: 'diagram', revision: 2, title: 'Architecture', markdown: '', blocks: [], document: { nodes: [{ id: 'node' }] } },
  ];
  const original = JSON.stringify(sources);
  assert.ok(original.length > MAX_DESIGN_MODEL_CONTEXT);
  const previousVisual = { body: '<section>Previous Blueprint</section>' };
  const visual = JSON.parse(designModelContext(sources, 'visual', { previousVisual, brief: 'Keep all requirements' }));
  assert.equal(visual.sources[0].markdown, markdown);
  assert.equal('blocks' in visual.sources[0], false);
  assert.deepEqual(visual.sources[0], { id: SPEC, role: 'spec', revision: 5, title: 'Complete spec', markdown });
  assert.deepEqual(visual.sources[2].document, sources[2]!.document);
  assert.deepEqual(visual.previousVisual, previousVisual);
  const feedback = [{ instruction: 'Keep evidence and revise the requirement', element_id: 'overview' }];
  const review = JSON.parse(designModelContext(sources, 'review', { artifact: previousVisual, feedback, allowedIds: [SPEC] }));
  assert.deepEqual(review.sources[0].blocks, blocks);
  assert.equal('markdown' in review.sources[0], false);
  assert.equal(review.sources[1].markdown, 'Source heading');
  assert.deepEqual(review.sources[2].document, sources[2]!.document);
  assert.deepEqual(review.feedback, feedback);
  assert.deepEqual(review.allowedIds, [SPEC]);
  assert.equal(JSON.stringify(sources), original);
});

test('Blueprint context limits include the exact previous visual, feedback and allowed IDs payload', () => {
  for (const mode of ['visual', 'review'] as const) {
    const context = { previousVisual: { body: '' }, feedback: ['Feedback'], allowedIds: [SPEC] };
    const overhead = designModelContext([], mode, context).length;
    context.previousVisual.body = 'x'.repeat(MAX_DESIGN_MODEL_CONTEXT - overhead);
    assert.equal(designModelContext([], mode, context).length, MAX_DESIGN_MODEL_CONTEXT);
    context.previousVisual.body += 'x';
    assert.throws(() => designModelContext([], mode, context), /exceeds 750,000 characters.*nothing was truncated/);
  }
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

test('reference notes stay independent while document roles consistently drive grouping and Design navigation', async () => {
  const local = new PGlite();
  const reference = randomUUID();
  const secondParent = randomUUID();
  await local.exec(`
    CREATE TABLE notes(id UUID PRIMARY KEY,content TEXT,status TEXT DEFAULT 'active',project_id TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE designs(id UUID PRIMARY KEY,parent_note_id UUID,source_note_id UUID,source_use_case_id UUID,
      summary TEXT DEFAULT '',status TEXT DEFAULT 'draft',revision INTEGER DEFAULT 1,specification_type TEXT,selections JSONB DEFAULT '{}');
    CREATE TABLE design_assets(design_id UUID,source_type TEXT,source_id TEXT,role TEXT,excluded BOOLEAN DEFAULT false,
      added_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(design_id,source_type,source_id));
    CREATE TABLE note_links(source_note_id UUID,target_note_id UUID);
    CREATE TABLE note_entity_links(source_note_id UUID,target_type TEXT,target_id TEXT);
    CREATE TABLE use_cases(id UUID,spec_note_id UUID);
    CREATE TABLE use_case_sources(use_case_id UUID,source_type TEXT,source_id TEXT);
    CREATE TABLE canvases(id UUID,title TEXT,canvas_type TEXT,deleted_at TIMESTAMPTZ);
    CREATE TABLE canvas_notes(canvas_id UUID,note_id TEXT);
    CREATE TABLE diagram_element_notes(canvas_id UUID,note_id TEXT);
  `);
  await local.exec(await readFile(new URL('../src/db/migrations/064_note_list_metadata.sql', import.meta.url), 'utf8'));
  await local.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)', [
    ROOT, writing('Use case', 'use-case', 'Source'), SPEC, writing('Spec', 'spec', 'Specification'),
    reference, writing('Digital Steward', 'note', 'Shared reference'),
    OTHER, writing('Design', 'design', 'Parent'), secondParent, writing('Second Design', 'design', 'Parent'),
  ]);
  await local.query('INSERT INTO designs(id,parent_note_id,source_note_id) VALUES($1,$1,$2),($3,$3,$2)', [OTHER, ROOT, secondParent]);
  await local.query('INSERT INTO note_links VALUES($1,$2),($1,$3)', [ROOT, SPEC, reference]);
  const query = mock.method(getDb(), 'query', (sql: string, values?: unknown[]) => local.query(sql, values));
  const grouped = async (id: string) => (await local.query<{ parent_note_id: string }>(
    `SELECT parent_note_id FROM (${DESIGN_NOTE_MEMBERSHIPS_SQL}) memberships WHERE note_id=$1 ORDER BY parent_note_id`, [id])).rows;
  try {
    const before = (await local.query('SELECT id,content FROM notes ORDER BY id')).rows;
    assert.deepEqual(await assetDesigns(getDb(), 'note', reference), [],
      'Even multiple reference-only memberships must not redirect or ask for a parent');
    assert.deepEqual(await grouped(reference), []);
    assert.equal((await getDesign(getDb(), OTHER)).assets.find(asset => asset.sourceId === reference)?.role, 'reference',
      'The Design retains reference material and its links');
    for (const [id, role] of [[ROOT, 'use_case'], [SPEC, 'spec']]) {
      const membership = await assetDesigns(getDb(), 'note', id!);
      assert.equal(membership.length, 2);
      assert.ok(membership.every(item => item.role === role));
      assert.deepEqual(new Set(membership.map(item => item.parentNoteId)), new Set((await grouped(id!)).map(item => item.parent_note_id)));
    }
    await local.query("INSERT INTO design_assets(design_id,source_type,source_id,role) VALUES($1,'note',$2,'reference'),($3,'note',$2,'reference')",
      [OTHER, SPEC, secondParent]);
    assert.deepEqual(await assetDesigns(getDb(), 'note', SPEC), [], 'Explicit reference assignments override an inferred spec role');
    assert.deepEqual(await grouped(SPEC), []);
    await local.query("INSERT INTO design_assets(design_id,source_type,source_id,role) VALUES($1,'note',$2,'architecture')", [OTHER, reference]);
    assert.deepEqual((await assetDesigns(getDb(), 'note', reference)).map(item => item.parentNoteId), [OTHER],
      'An explicit document assignment still groups an ordinary note, ignoring its other reference-only parent');
    assert.deepEqual(await grouped(reference), [{ parent_note_id: OTHER }]);
    await local.query("UPDATE design_assets SET excluded=true WHERE design_id=$1 AND source_id=$2", [OTHER, reference]);
    assert.deepEqual(await assetDesigns(getDb(), 'note', reference), []);
    assert.deepEqual(await grouped(reference), []);
    assert.deepEqual((await local.query('SELECT id,content FROM notes ORDER BY id')).rows, before);
    assert.equal((await local.query('SELECT count(*)::int AS count FROM note_links')).rows[0]?.count, 2,
      'Visibility and navigation changes never remove note links or backlinks');
  } finally { query.mock.restore(); await local.close(); }
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
  await local.exec('CREATE TABLE agent_jobs(id UUID PRIMARY KEY)');
  for (const file of ['054_ai_usage_log.sql', '067_ai_usage_measured.sql', '117_ai_workflow_attribution.sql']) {
    await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  for (const file of ['060_note_history.sql', '061_note_github_publications.sql', '064_note_list_metadata.sql', '082_note_links.sql', '102_designs.sql', '103_design_note_origins.sql']) {
    await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const original = writing('Claims', 'use-case', 'Original requirement');
  await local.query('INSERT INTO notes(id,content) VALUES($1,$2),($3,$4)', [ROOT, original, SPEC, writing('Claims spec', 'spec', 'Original specification')]);
  for (const file of ['104_design_note_artifacts.sql', '105_design_note_parent_trigger.sql', '111_design_specification_type.sql']) await local.exec(await readFile(new URL(`../src/db/migrations/${file}`, import.meta.url), 'utf8'));
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
    assert.equal(design.specificationType, null);
    await assert.rejects(writeDesignSpec(getDb(), design.id), /Choose Standard or IMAGINE/);
    for (const expectedRevision of [undefined, -1, 0.5, '0']) {
      await assert.rejects(setSpecificationType(getDb(), design.id, { specificationType: 'standard', expectedRevision }), /valid Design revision/);
    }
    await assert.rejects(setSpecificationType(getDb(), design.id, { specificationType: 'guessed', expectedRevision: design.revision }), /Standard or IMAGINE/);
    const initialRevision = design.revision;
    design = await setSpecificationType(getDb(), design.id, { specificationType: 'imagine', expectedRevision: initialRevision });
    assert.equal((await getDesign(getDb(), design.id)).specificationType, 'imagine');
    await assert.rejects(setSpecificationType(getDb(), design.id, { specificationType: 'standard', expectedRevision: initialRevision }), /Design changed/);
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

    let response: string | null = null;
    let lastCall: unknown[] = [];
    const requestedSections: number[][] = [];
    let timeoutOnce = true;
    let changeTypeDuringGeneration = false;
    const writerMock = mock.method(getFoundryClient('use-case-spec'), 'chatBulk', async (...args: unknown[]) => {
      lastCall = args;
      if (changeTypeDuringGeneration) {
        const current = await getDesign(getDb(), design.id);
        await setSpecificationType(getDb(), design.id, { specificationType: 'imagine', expectedRevision: current.revision });
      }
      if (response !== null) return response;
      const request = JSON.parse((args[0] as { content: string }[])[1]!.content) as { sections: number[] };
      requestedSections.push(request.sections);
      if (request.sections[0] === 3 && timeoutOnce) { timeoutOnce = false; throw new AiError('Bulk request timed out after 270000ms'); }
      const form = demoSpecificationForm(request.sections) as { fields: { id: string }[]; tables: { id: string }[] };
      return JSON.stringify({
        name: 'Claims',
        values: Object.fromEntries(form.fields.map(field => [field.id, `Unresolved - confirm ${field.id} with the owner before implementation.`])),
        additionalRows: Object.fromEntries(form.tables.map(table => [table.id, []])),
        sectionDetails: Object.fromEntries(request.sections.map(section => [String(section), 'Proposed - reviewer confirms the applicable business rules before implementation.'])),
      });
    });
    try {
      const imagined = await writeDesignSpec(getDb(), design.id, true);
      assert.equal(imagined.noteId, SPEC, 'regeneration updates the selected spec in place');
      assert.deepEqual(lastCall[4], demoSpecificationResponseSchema([10]));
      assert.deepEqual(requestedSections, [[1], [2], [3], [3], [4], [5], [6], [7], [8], [9], [10]], 'only the timed-out section is regenerated');
      const imaginedSource = (await sourceSnapshot(getDb(), await getDesign(getDb(), design.id))).find(item => item.id === SPEC)!;
      assert.equal((imaginedSource.markdown.match(/^## \d+\./gm) ?? []).length, 10);
      assert.doesNotMatch(imaginedSource.markdown, /Source conversation:/);
      response = '{}';
      const beforeInvalid = (await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows;
      await assert.rejects(writeDesignSpec(getDb(), design.id, true), /incomplete or invalid/);
      assert.deepEqual((await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows, beforeInvalid);
      const current = await getDesign(getDb(), design.id);
      await setSpecificationType(getDb(), design.id, { specificationType: 'standard', expectedRevision: current.revision });
      response = '# Standard claims specification\n\n## Requirements\n\nThe reviewer must approve the evidence before submission.';
      await writeDesignSpec(getDb(), design.id, true);
      assert.equal(lastCall[4], undefined, 'Standard retains the product-spec writer');
      const beforeConflict = (await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows;
      changeTypeDuringGeneration = true;
      await assert.rejects(writeDesignSpec(getDb(), design.id, true), /Design.*changed/);
      assert.deepEqual((await local.query('SELECT content,revision FROM notes WHERE id=$1', [SPEC])).rows, beforeConflict);
    } finally { writerMock.mock.restore(); }
  } finally { modelMock.mock.restore(); queryMock.mock.restore(); connectionMock.mock.restore(); await local.close(); }
});
