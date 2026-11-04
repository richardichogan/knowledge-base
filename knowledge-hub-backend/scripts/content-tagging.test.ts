import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const { isDesignDoc, policyFor, taggingText, tagContent, TAGGABLE_SOURCES } = await import('../src/services/taxonomyService.js');
const { diagramTagText, autoTagNow } = await import('../src/services/autoTagging.js');
const { emptyDiagram } = await import('../src/types/diagram.js');

const repo = 'https://github.com/IBM-Project-Imagine/imagine-claims/blob/main';

test('diagrams use the note tagging policy but never enter the Discover tagging sweep', () => {
  assert.deepEqual(policyFor('diagram'), policyFor('note'));
  assert.ok(!TAGGABLE_SOURCES.includes('diagram'));
});

test('diagram tagging uses semantic shape content, not geometry or appearance', () => {
  const diagram = { ...emptyDiagram(), nodes: [{
    id: 'shape', kind: 'process' as const, label: 'Leave approval', description: 'Check the employee request with HR.',
    x: 100, y: 100, width: 120, height: 80, fill: '#ffffff', stroke: '#161616', textColor: '#161616',
    fontSize: 14, assetId: null, parentId: null,
  }], footnotes: [{ id: 'footnote', targetId: 'shape', source: 'custom' as const, text: 'Retain the approval audit evidence.' }] };
  const text = diagramTagText('HR agents', 'Leave of absence workflow', diagram);
  assert.match(text, /Leave approval/);
  assert.match(text, /Retain the approval audit evidence/);
  const moved = { ...diagram, nodes: diagram.nodes.map(node => ({ ...node, x: -300, y: 800, fill: '#000000', fontSize: 18 })) };
  assert.equal(diagramTagText('HR agents', 'Leave of absence workflow', moved), text);
  assert.notEqual(diagramTagText('New title', 'Leave of absence workflow', diagram), text);
  assert.ok(text.length <= 6_000);
});

test('unchanged and deleted diagrams skip tagging without a provider call', async () => {
  const document = { ...emptyDiagram(), nodes: [] };
  const title = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha1').update(diagramTagText(title, null, document)).digest('hex');
  const calls: string[] = [];
  const db = { query: (sql: string) => {
    calls.push(sql);
    return Promise.resolve({ rows: sql.includes('FROM canvases')
      ? [{ title, description: null, document }] : [{ content_hash: hash }] });
  } } as unknown as Pool;
  assert.deepEqual(await autoTagNow(db, 'diagram', 'diagram-id'), { applied: 0, skipped: 'unchanged' });
  assert.match(calls[0] ?? '', /deleted_at IS NULL/);
  assert.equal(calls.length, 2);
  const deleted = { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool;
  assert.deepEqual(await autoTagNow(deleted, 'diagram', 'deleted'), { applied: 0, skipped: 'not found' });
});

test('design and instructional GitHub docs are recognised', () => {
  for (const path of [
    '/docs/decisions/0008-self-hosted-runners-on-linux-vm.md',
    '/README.md',
    '/.github/skills/playwright-cli/SKILL.md',
    '/.github/agents/neo.product.engineer.agent.md',
    '/specs/archive/001-neo-agent-plugin-multi-platform/spec.md',
    '/docs/design/developer/claim-processing-workflow-implementation-status.md',
    '/product/PRD-claims-intake.md',
    '/src/agents/steward-agent/instructions.md',
  ]) assert.equal(isDesignDoc(`${repo}${path}`), true, path);
});

test('session notes, status reports and changelogs are not design docs', () => {
  for (const path of [
    '/docs/sessions/SESSION-NOTES-2026-02-21.md',
    '/docs/status/architecture/2026-07-06-status-report.md',
    '/CHANGELOG.md',
    '/.copilot-tracking/dt/notes.md',
    '/backend/src/data/mortgage-policy/MLP-001-lending-criteria.md',
  ]) assert.equal(isDesignDoc(`${repo}${path}`), false, path);
  assert.equal(isDesignDoc(null), false);
});

test('only design GitHub docs are tagged, with existing tags and the project tag', () => {
  assert.deepEqual(policyFor('github-doc', `${repo}/docs/architecture/overview.md`), { mode: 'ai', mayPropose: false, projectTag: true });
  assert.equal(policyFor('github-doc', `${repo}/docs/sessions/notes.md`).mode, 'none');
  assert.equal(policyFor('github-doc').mode, 'none');
  assert.equal(policyFor('github-commit', `${repo}/README.md`).mode, 'none');
  assert.ok(TAGGABLE_SOURCES.includes('github-doc'));
  assert.ok(TAGGABLE_SOURCES.includes('discovered-article'));
  assert.ok(!TAGGABLE_SOURCES.includes('github-action'));
  assert.ok(!TAGGABLE_SOURCES.includes('note'));
});

test('GitHub docs are tagged from body and path; other items from summary', () => {
  const doc = taggingText({ source: 'github-doc', title: 'Spec', summary: 'stub', body: 'Full spec body', url: `${repo}/specs/spec.md` });
  assert.match(doc, /Path: IBM-Project-Imagine\/imagine-claims\/blob\/main\/specs\/spec\.md/);
  assert.match(doc, /Full spec body/);
  assert.doesNotMatch(doc, /stub/);
  assert.equal(taggingText({ source: 'discovered-article', title: 'T', summary: 'S', body: 'B', url: null }), 'T\n\nS');
  assert.equal(taggingText({ source: 'discovered-article', title: 'T', summary: '', body: 'B', url: null }), 'T\n\nB');
});

test('an untaggable item records a skipped outcome', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: (sql: string, params: unknown[]) => { calls.push({ sql, params }); return Promise.resolve({ rows: [], rowCount: 1 }); } } as unknown as Pool;
  const result = await tagContent(db, 'some text long enough to tag', 'item-1', 'github-doc', 'Notes', { url: `${repo}/docs/sessions/x.md` });
  assert.deepEqual(result, { appliedTagIds: [], suggestedNewTags: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? '', /tagging_status = \$2/);
  assert.deepEqual(calls[0]?.params, ['item-1', 'skipped']);
});
