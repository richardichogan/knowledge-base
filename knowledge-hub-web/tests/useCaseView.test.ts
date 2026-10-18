import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UseCase } from '../src/types/useCases';
import { boardColumnForUseCase, defaultHandoffPath, filterUseCases, groupByProduct, isStalled, launchFromRef, sinceLabel, sourceHref, stalledNudge } from '../src/features/useCases/useCaseView';

const NOW = Date.parse('2026-05-01T12:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();
const uc = (over: Partial<UseCase>): UseCase => ({
  id: 'x', title: 'T', summary: '', productKind: 'product', projectId: null, projectName: null, repo: null,
  stage: 'candidate', specNoteId: null, buildSpecId: null, handoffRepo: null, handoffPath: null, handoffUrl: null,
  sourceCount: 0, linkCount: 0, createdAt: daysAgo(30), updatedAt: daysAgo(0), stageChangedAt: daysAgo(0), ...over,
});

test('filters: active hides shipped and dropped; kind and project narrow the list', () => {
  const list = [uc({ id: 'a' }), uc({ id: 'b', stage: 'shipped' }), uc({ id: 'c', stage: 'dropped' }),
    uc({ id: 'd', productKind: 'imagine_demo', projectId: 'p1' })];
  assert.deepEqual(filterUseCases(list, { stage: 'active', kind: 'all', project: '' }).map((u) => u.id), ['a', 'd']);
  assert.deepEqual(filterUseCases(list, { stage: 'all', kind: 'all', project: '' }).length, 4);
  assert.deepEqual(filterUseCases(list, { stage: 'shipped', kind: 'all', project: '' }).map((u) => u.id), ['b']);
  assert.deepEqual(filterUseCases(list, { stage: 'all', kind: 'imagine_demo', project: 'p1' }).map((u) => u.id), ['d']);
  assert.deepEqual(filterUseCases(list, { stage: 'all', kind: 'all', project: 'p2' }), []);
});

test('groups follow product order, newest first, and skip empty groups', () => {
  const groups = groupByProduct([uc({ id: 'old', updatedAt: daysAgo(5) }), uc({ id: 'new' }), uc({ id: 'demo', productKind: 'imagine_demo' })]);
  assert.deepEqual(groups.map((g) => [g.kind, g.items.map((u) => u.id)]), [['imagine_demo', ['demo']], ['product', ['new', 'old']]]);
});

test('maps active use case stages to task board columns without showing closed cases', () => {
  assert.equal(boardColumnForUseCase('candidate'), 'backlog');
  assert.equal(boardColumnForUseCase('refining'), 'in-progress');
  assert.equal(boardColumnForUseCase('spec_ready'), 'in-progress');
  assert.equal(boardColumnForUseCase('handed_off'), 'in-progress');
  assert.equal(boardColumnForUseCase('shipped'), null);
  assert.equal(boardColumnForUseCase('dropped'), null);
});

test('since labels and the stalled rule', () => {
  assert.equal(sinceLabel(daysAgo(0), NOW), 'today');
  assert.equal(sinceLabel(daysAgo(1), NOW), '1 day');
  assert.equal(sinceLabel(daysAgo(13), NOW), '13 days');
  assert.equal(sinceLabel(daysAgo(21), NOW), '3 weeks');
  assert.equal(isStalled({ stage: 'refining', updatedAt: daysAgo(14) }, NOW), true);
  assert.equal(isStalled({ stage: 'spec_ready', updatedAt: daysAgo(13) }, NOW), false);
  assert.equal(isStalled({ stage: 'candidate', updatedAt: daysAgo(40) }, NOW), false);
});

test('source links and default handoff paths', () => {
  assert.deepEqual(sourceHref({ sourceType: 'note', sourceId: 'n 1', url: null }), { href: '/think?noteId=n%201', external: false });
  assert.deepEqual(sourceHref({ sourceType: 'canvas', sourceId: 'c1', url: null }), { href: '/think?mapId=c1', external: false });
  assert.deepEqual(sourceHref({ sourceType: 'discover', sourceId: 'd', url: 'https://e.com' }), { href: 'https://e.com', external: true });
  assert.equal(sourceHref({ sourceType: 'discover', sourceId: 'd', url: null }), null);
  assert.equal(sourceHref({ sourceType: 'spark', sourceId: 's', url: null }), null);
  assert.equal(defaultHandoffPath('Claims Triage!', 'imagine_platform'), 'docs/prds/claims-triage.md');
  assert.equal(defaultHandoffPath('', 'product'), 'docs/specs/use-case.md');
});

test('right-clicked items map to use case sources', () => {
  assert.deepEqual(launchFromRef('discover_item', 'd1', '  Agentic   claims '), {
    title: 'Agentic claims', sources: [{ sourceType: 'discover', sourceId: 'd1' }], sourceLabel: 'Discover “Agentic claims”',
  });
  assert.equal(launchFromRef('note', 'n1', 'N')?.sources[0]?.sourceType, 'note');
  assert.equal(launchFromRef('spark', 's1', 'S')?.sources[0]?.sourceType, 'spark');
  assert.equal(launchFromRef('task', 't1', 'T'), null);
  assert.equal(launchFromRef('note', '', 'T'), null);
  assert.equal(launchFromRef(undefined, 'x', 'T'), null);
  assert.ok(launchFromRef('note', 'n', 'x'.repeat(300))!.sourceLabel.endsWith('…”'));
});

test('Today nudge counts stalled use cases and hides at zero', () => {
  assert.equal(stalledNudge([], NOW), null);
  assert.equal(stalledNudge([uc({ stage: 'refining', updatedAt: daysAgo(3) }), uc({ stage: 'candidate', updatedAt: daysAgo(40) })], NOW), null);
  assert.equal(stalledNudge([uc({ stage: 'spec_ready', updatedAt: daysAgo(14) })], NOW), '1 use case has not moved in two weeks');
  assert.equal(stalledNudge([uc({ stage: 'refining', updatedAt: daysAgo(20) }), uc({ stage: 'spec_ready', updatedAt: daysAgo(30) }),
    uc({ stage: 'shipped', updatedAt: daysAgo(30) })], NOW), '2 use cases have not moved in two weeks');
});
