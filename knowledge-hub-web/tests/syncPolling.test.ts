import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollSyncRun } from '../src/services/syncPolling';
import type { SyncRun } from '../src/services/api';

const run: SyncRun = { id: 'run-id', status: 'running', startedAt: '', finishedAt: null, results: [] };
test('sync monitoring waits for the exact run outcome, surviving transient read failures', async () => {
  let reads = 0;
  const completed = await pollSyncRun(async () => {
    reads++;
    if (reads === 2) throw new Error('Unavailable');
    return reads < 4 ? run : { ...run, status: 'partial' };
  }, new AbortController().signal, 1, 200);
  assert.equal(reads, 4);
  assert.equal(completed.status, 'partial');
});
test('sync monitoring times out honestly even if every read fails or hangs', async () => {
  await assert.rejects(pollSyncRun(async () => { throw new Error('Offline'); },
    new AbortController().signal, 1, 20), /timed out.*Offline.*completion has not been confirmed/);
  await assert.rejects(pollSyncRun(async () => new Promise(() => {}),
    new AbortController().signal, 1, 20), /timed out/);
});
test('unmount cancellation stops monitoring without triggering a sync', async () => {
  const controller = new AbortController();
  const waiting = pollSyncRun(async () => run, controller.signal, 100, 200);
  controller.abort(new Error('Unmounted'));
  await assert.rejects(waiting, /Unmounted/);
});
