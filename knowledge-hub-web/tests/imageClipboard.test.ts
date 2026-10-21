import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

test('image copying converts actual pixels to PNG and surfaces read/clipboard errors', async () => {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/utils/imageClipboard.ts', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'cjs' });
  const module = { exports: {} as { copyImage(source: string): Promise<void> } };
  let status = 200;
  let clipboardDenied = false;
  let copied: Blob | undefined;
  let drawn = false;
  let closed = 0;
  const context = createContext({
    module, exports: module.exports, Blob,
    fetch: async () => ({ ok: status === 200, status, blob: async () => new Blob(['jpeg pixels'], { type: 'image/jpeg' }) }),
    createImageBitmap: async () => ({ width: 80, height: 60, close: () => { closed++; } }),
    document: { createElement: () => ({
      getContext: () => ({ drawImage: () => { drawn = true; } }),
      toBlob: (resolve: (value: Blob) => void) => resolve(new Blob(['png pixels'], { type: 'image/png' })),
    }) },
    ClipboardItem: class { constructor(public data: Record<string, Promise<Blob>>) {} },
    navigator: { clipboard: { write: async (items: { data: Record<string, Promise<Blob>> }[]) => {
      copied = await items[0]!.data['image/png'];
      if (clipboardDenied) throw new Error('Clipboard permission denied');
    } } },
  });
  runInContext(compiled.outputFiles[0]!.text, context);
  await module.exports.copyImage('https://images.example/signed-image');
  assert.ok(drawn);
  assert.equal(copied?.type, 'image/png');
  assert.equal(await copied?.text(), 'png pixels');
  assert.equal(closed, 1);
  status = 403;
  await assert.rejects(module.exports.copyImage('https://images.example/expired'), /403/);
  status = 200;
  clipboardDenied = true;
  await assert.rejects(module.exports.copyImage('https://images.example/image'), /permission denied/);
});
