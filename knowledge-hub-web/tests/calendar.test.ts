import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarDateKey, calendarTaskItems, loadCalendarItems } from '../src/services/calendarItems';
import { dateOnlyToLocal, localDateKey } from '../src/utils/dateOnly';
import type { ContentItemSummary } from '../src/types';
import type { TimelineQuery } from '../src/services/api';

function item(id: string, source: ContentItemSummary['source'] = 'graph-calendar'): ContentItemSummary {
  return { id, source, sourceId: id, title: id, summary: '', publishedAt: '2026-10-12T10:00:00Z' };
}

test('date-only keys survive UK midnight and both DST boundaries without UTC conversion', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    for (const day of ['2026-03-29', '2026-03-30', '2026-10-12', '2026-10-25', '2026-10-26']) {
      assert.equal(localDateKey(dateOnlyToLocal(day)), day);
      assert.equal(localDateKey(new Date(`${day}T00:00:00`)), day);
    }
    assert.equal(new Date('2026-10-12T00:00:00').toISOString().slice(0, 10), '2026-10-11');
    for (const invalid of ['2026-02-30', '2026-13-01', 'bad', '2026-1-1', '2026-10-12T00:00:00Z']) {
      assert.throws(() => dateOnlyToLocal(invalid), /Invalid date-only/);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('native tasks use due date or recurring start, not indexed timestamps; completed tasks are excluded', () => {
  const tasks = calendarTaskItems({ success: true, data: { items: [
    { id: 'due', title: 'Due', status: 'backlog', dueDate: '2026-10-14', updatedAt: '2026-10-01', taxonomyTagIds: ['tag'] },
    { id: 'recurring', title: 'Recurring', status: 'in-progress', startDate: '2026-10-15', recurringCadence: 'weekly' },
    { id: 'done', title: 'Done', status: 'completed', dueDate: '2026-10-14' },
    { id: 'unscheduled', title: 'Unscheduled', status: 'backlog', updatedAt: '2026-10-14' },
  ] } });
  assert.deepEqual(tasks.map((task) => calendarDateKey(task)), ['2026-10-14', '2026-10-15']);
  assert.deepEqual(tasks[0]?.taxonomyTagIds, ['tag']);
  assert.equal(tasks[0]?.url, '/plan?taskId=due');
  const external = { ...item('external', 'graph-todo'), metadata: { dueDateTime: '2026-10-16T00:00:00Z', status: 'notStarted' } };
  assert.equal(calendarDateKey(external), '2026-10-16');
  assert.equal(calendarDateKey({ ...external, metadata: { ...external.metadata, status: 'completed' } }), null);
  assert.equal(calendarDateKey({ ...external, metadata: {} }), null);
  assert.throws(() => calendarTaskItems({ success: true, data: {} }), /Invalid task list/);
});

test('Calendar requests exact range, exhausts pages beyond 100 and propagates partial source failures', async () => {
  const calls: TimelineQuery[] = [];
  const rangeStart = '2026-10-11T23:00:00Z';
  const rangeEnd = '2026-10-18T23:00:00Z';
  const client = {
    getTimeline: async (query: TimelineQuery = {}) => {
      calls.push(query);
      const ids = query.page === 1 ? Array.from({ length: 100 }, (_, i) => String(i)) : ['100'];
      return { success: true as const, data: { items: ids.map((id) => item(id)), page: query.page ?? 1, pageSize: 100, total: 101, hasMore: query.page === 1 } };
    },
    getTasks: async (query?: Record<string, string>) => {
      assert.deepEqual(query, { projectId: 'project' });
      return { success: true as const, data: { items: [] } };
    },
  };
  const options = { rangeStart, rangeEnd, project: 'project', tag: '' };
  const items = await loadCalendarItems(client, options);
  assert.equal(items.length, 101);
  assert.equal(new Set(items.map((row) => row.id)).size, 101);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.rangeStart, rangeStart);
    assert.equal(call.rangeEnd, rangeEnd);
    assert.equal(call.projectContext, 'project');
  }
  await assert.rejects(loadCalendarItems({
    ...client, getTimeline: async () => ({ success: false, error: { code: 'FIXTURE', message: 'Source failed' } }),
  }, options), /Source failed/);
});
