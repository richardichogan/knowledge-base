import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('daily capture has an AI-sized timeout rather than the ordinary eight-second request timeout', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/services/api.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', define: { 'import.meta.env': '{}' },
    plugins: [{
      name: 'fixture-api-transport',
      setup(builder) {
        builder.onResolve({ filter: /^axios$/ }, () => ({ path: 'axios', namespace: 'fixture' }));
        builder.onResolve({ filter: /^\.\/auth$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: args.path === 'axios'
            ? 'export default {create: () => globalThis.__dailyApiFixture};'
            : 'export const getApiToken = async () => "";',
        }));
      },
    }],
  });
  let timeout = 0;
  const globals = globalThis as unknown as { __dailyApiFixture?: unknown };
  globals.__dailyApiFixture = {
    interceptors: { request: { use() {} } },
    post: async (path: string, _input: unknown, config: { timeout: number }) => {
      assert.equal(path, '/api/capture/daily-insights');
      timeout = config.timeout;
      return { data: { success: true } };
    },
  };
  const module = { exports: {} as { api: { captureDailyInsights(input: object): Promise<unknown> } } };
  try {
    new Function('module', 'exports', bundle.outputFiles[0]?.text ?? '')(module, module.exports);
    await module.exports.api.captureDailyInsights({});
    assert.equal(timeout, 240_000);
  } finally { delete globals.__dailyApiFixture; }
});

test('structured capture retries independently of a successful, unchanged upload index', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/services/localSync.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{
      name: 'fixture-transport',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
        builder.onResolve({ filter: /^\.\/apiError$/ }, () => ({ path: 'apiError', namespace: 'fixture' }));
        builder.onResolve({ filter: /^\.\.\/types\/desktop$/ }, () => ({ path: 'desktop', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: args.path === 'api'
            ? 'export const api = globalThis.__dailySyncFixture.api;'
            : args.path === 'desktop'
              ? 'export const getDesktop = () => globalThis.__dailySyncFixture.desktop; export const desktopErrorMessage = e => e.message;'
              : 'export const requireApiData = r => { if (!r.success) throw new Error(r.error.message); return r.data; }; export const describeApiError = e => e.message;',
        }));
      },
    }],
  });
  let captures = 0;
  let uploads = 0;
  const path = 'C:\\Reports\\Daily-Briefing-2026-10-20.md';
  const ok = (data: unknown): object => ({ success: true, data });
  const globals = globalThis as unknown as { __dailySyncFixture?: unknown };
  globals.__dailySyncFixture = {
    desktop: {
      device: async () => ({ deviceId: 'fixture', deviceName: 'fixture' }),
      scan: async () => ({ files: [{ path, folderId: 'f', localKey: 'key', hash: 'same', size: 100, modifiedAt: '2026-10-20' }], skipped: [] }),
      listFolders: async () => [{ id: 'f', path: 'C:\\Reports', name: 'Reports', source: 'daily-insights' }],
      readText: async () => 'fixture report',
    },
    api: {
      getLocalIndex: async () => ok([{ localKey: 'key', localHash: 'same', localPath: path }]),
      captureDailyInsights: async () => {
        captures++;
        if (captures === 1) throw new Error('offline');
        return ok({ date: '2026-10-20', knowledgeDate: '2026-10-19', tasksCreated: 1, tasksUpdated: 0, tasksPreserved: 0, meetings: 2, warnings: [], unchanged: false });
      },
      uploadLocalDocument: async () => { uploads++; throw new Error('must not reupload unchanged file'); },
    },
  };
  const module = { exports: {} as { syncLocalFolders(): Promise<void>; getLocalSyncStatus(): { problems: unknown[]; dailyInsights: unknown[] } } };
  try {
    new Function('module', 'exports', bundle.outputFiles[0]?.text ?? '')(module, module.exports);
    await module.exports.syncLocalFolders();
    assert.equal(module.exports.getLocalSyncStatus().problems.length, 1);
    await module.exports.syncLocalFolders();
    assert.equal(captures, 2);
    assert.equal(uploads, 0);
    assert.equal(module.exports.getLocalSyncStatus().problems.length, 0);
    assert.equal(module.exports.getLocalSyncStatus().dailyInsights.length, 1);
  } finally { delete globals.__dailySyncFixture; }
});
