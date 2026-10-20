import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FolderRegistry } from '../src/folders';

test('explicit Daily Insights registration persists and does not broaden folder access', async () => {
  const root = resolve(`.daily-insights-fixture-${randomUUID()}`);
  await mkdir(join(root, 'Daily Insights'), { recursive: true });
  const path = join(root, 'folders.json');
  try {
    const registry = new FolderRegistry(path);
    const folder = await registry.add(join(root, 'Daily Insights'));
    assert.equal(folder.source, undefined);
    await registry.add(folder.path, 'daily-insights');
    const reloaded = await new FolderRegistry(path).folders();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]?.source, 'daily-insights');
    assert.equal(reloaded[0]?.path, folder.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});
