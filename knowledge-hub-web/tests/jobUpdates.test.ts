import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

test('job results persist unread, acknowledge selectively and follow cross-tab updates', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/services/jobUpdates.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  });
  const storage = new Map<string, string>();
  function tab() {
    const events = new Map<string, (event: { key: string }) => void>();
    const module = { exports: {} as typeof import('../src/services/jobUpdates') };
    runInNewContext(bundle.outputFiles[0]!.text, {
      module, exports: module.exports, Date, console,
      localStorage: { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); } },
      window: { addEventListener: (name: string, handler: (event: { key: string }) => void) => { events.set(name, handler); } },
      require: (name: string) => {
        assert.equal(name, 'react');
        return { useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() };
      },
    });
    return { api: module.exports, refresh: () => events.get('storage')?.({ key: 'athena-job-updates' }) };
  }
  const first = tab();
  const announce = (id: string) => first.api.announceAthenaJob({
    id, always: true, ok: true, title: 'Ready', body: 'Saved result', url: '/think', tag: id, startedAt: Date.now(),
  });
  announce('one');
  announce('two');
  assert.equal(first.api.useJobUpdates().filter(update => !update.seen).length, 2, 'reading the list must not acknowledge it');
  first.api.markJobUpdatesSeen([]);
  assert.equal(first.api.useJobUpdates().filter(update => !update.seen).length, 2);
  first.api.markJobUpdatesSeen(['one']);
  assert.equal(first.api.useJobUpdates().find(update => update.id === 'one')?.seen, true);
  assert.equal(first.api.useJobUpdates().find(update => update.id === 'two')?.seen, false);
  announce('one');
  assert.equal(first.api.useJobUpdates().length, 2, 'repeated delivery must not reset read state');
  const second = tab();
  assert.equal(second.api.useJobUpdates().filter(update => !update.seen).length, 1, 'reload retains unread results');
  second.api.markJobUpdatesSeen();
  first.refresh();
  assert.equal(first.api.useJobUpdates().filter(update => !update.seen).length, 0);
  announce('three');
  second.refresh();
  assert.equal(second.api.useJobUpdates().filter(update => !update.seen).length, 1, 'late arrivals remain visible');
  first.api.announceAthenaJob({
    id: 'information', always: true, ok: true, kind: 'information',
    title: 'Athena information', body: 'A new informational update', url: '/think', tag: 'information', startedAt: Date.now(),
  });
  second.refresh();
  assert.equal(second.api.useJobUpdates().find(update => update.id === 'information')?.kind, 'information',
    'explicit information events retain their category across tabs');
  assert.equal(second.api.useJobUpdates().find(update => update.id === 'three')?.kind, undefined,
    'existing completions are not relabelled as information');
});
