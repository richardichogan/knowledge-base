import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('desktop scheduled work waits for the correct dated file, preserves mtime and uses guarded unique output paths', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/services/desktopJobs.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'desktop-job-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      builder.onResolve({ filter: /^\.\.\/types\/desktop$/ }, () => ({ path: 'desktop', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'api'
        ? 'export const api = globalThis.__desktopJobs.api;'
        : 'export const getDesktop = () => globalThis.__desktopJobs.desktop;' }));
    } }],
  });
  const root = 'C:\\Reports';
  const path = `${root}\\Daily-Briefing-2026-10-24.md`;
  const modifiedAt = '2026-10-24T06:12:00Z';
  let run = { id: 'fixture-run', scheduledAt: '2026-10-24T05:00:00Z', definition: { kind: 'm365-import', inputFolder: root, outputFolder: root,
    schedule: { timezone: 'Europe/London' } }, artifacts: { markdown: 'generated report' } };
  let result: Record<string, unknown> = {};
  let writes = 0;
  let existing: string | null = null;
  let reads = 0;
  let authorised = true;
  const fixture = {
    api: { jobs: async (url: string, _method: string, data: Record<string, unknown>) => {
      if (url === '/desktop/claim') return { managedImport: true, work: { run, lease: 'fixture-lease' } };
      result = data;
      return { status: 'succeeded' };
    } },
    desktop: {
      device: async () => ({ deviceId: 'device', deviceName: 'PC' }),
      listFolders: async () => authorised ? [{ id: 'folder', path: root, name: 'Reports' }] : [],
      readText: async (filePath: string) => { reads++; return filePath === path ? 'today report' : existing; },
      writeText: async (filePath: string, content: string) => { assert.equal(filePath, `${root}\\athena-fixture-run.md`); assert.equal(content, 'generated report'); writes++; },
    },
  };
  const globals = globalThis as unknown as { __desktopJobs?: unknown };
  globals.__desktopJobs = fixture;
  const module = { exports: {} as { syncDesktopJobs(files: unknown[]): Promise<boolean> } };
  try {
    new Function('module', 'exports', bundle.outputFiles[0]!.text)(module, module.exports);
    assert.equal(await module.exports.syncDesktopJobs([]), true);
    assert.equal(result.waiting, true);
    assert.equal(reads, 0, 'must not substitute a different report');
    await module.exports.syncDesktopJobs([{ path, modifiedAt }]);
    assert.equal(result.filename, 'Daily-Briefing-2026-10-24.md');
    assert.equal(result.modifiedAt, modifiedAt);
    assert.equal(result.text, 'today report');
    run = { ...run, definition: { ...run.definition, kind: 'prompt' } };
    await module.exports.syncDesktopJobs([]);
    assert.equal(writes, 1);
    assert.equal(result.path, `${root}\\athena-fixture-run.md`);
    existing = 'generated report';
    await module.exports.syncDesktopJobs([]);
    assert.equal(writes, 1, 'receipt retry does not overwrite an existing same-content output');
    existing = 'edited by user';
    await assert.rejects(module.exports.syncDesktopJobs([]), /will not overwrite/);
    assert.equal(writes, 1);
    authorised = false;
    await assert.rejects(module.exports.syncDesktopJobs([]), /no longer authorised/);
  } finally { delete globals.__desktopJobs; }
});
