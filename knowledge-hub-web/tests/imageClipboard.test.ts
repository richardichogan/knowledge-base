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
    module, exports: module.exports, Blob, URL,
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

test('stored images use authenticated loading and SVG copying keeps clipboard activation and cleans up URLs', async () => {
    const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/utils/imageClipboard.ts', import.meta.url))],
      bundle: true, write: false, platform: 'browser', format: 'cjs' });
    type Loader = (id: string) => Promise<Blob>;
    const module = { exports: {} as {
      copyImage(source: string, loader: Loader): Promise<void>;
      imageAsPng(source: string, loader: Loader): Promise<Blob>;
    } };
    const id = '11111111-1111-4111-8111-111111111111';
    let release: ((blob: Blob) => void) | undefined;
    let clipboardStarted = false;
    let revoked = 0;
    let decodeFails = false;
    let copied: Blob | undefined;
    const context = createContext({
      module, exports: module.exports, Blob,
      URL: class extends URL {
        static override createObjectURL(): string { return 'blob:svg-preview'; }
        static override revokeObjectURL(): void { revoked++; }
      },
      fetch: () => { throw new Error('A stored image must not fetch its signed URL.'); },
      createImageBitmap: () => { throw new Error('SVGs must use Image.decode.'); },
      Image: class {
        naturalWidth = 80;
        naturalHeight = 60;
        async decode(): Promise<void> { if (decodeFails) throw new Error('SVG decode failed'); }
      },
      document: { createElement: () => ({
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (resolve: (value: Blob) => void) => resolve(new Blob(['png pixels'], { type: 'image/png' })),
      }) },
      ClipboardItem: class { constructor(public data: Record<string, Promise<Blob>>) {} },
      navigator: { clipboard: { write: async (items: { data: Record<string, Promise<Blob>> }[]) => {
        clipboardStarted = true;
        copied = await items[0]!.data['image/png'];
      } } },
    });
    runInContext(compiled.outputFiles[0]!.text, context);
    const copying = module.exports.copyImage(`https://storage.example/kb-images/${id}?expired=sas`, async requestedId => {
      assert.equal(requestedId, id);
      return await new Promise<Blob>(resolve => { release = resolve; });
    });
    assert.equal(clipboardStarted, true, 'clipboard.write starts before the image request completes');
    release!(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    await copying;
    assert.equal(copied?.type, 'image/png');
    assert.equal(revoked, 1);
    decodeFails = true;
    await assert.rejects(module.exports.imageAsPng(`/kb-images/${id}`, async () => new Blob(['<svg/>'], { type: 'image/svg+xml' })), /SVG decode failed/);
    assert.equal(revoked, 2, 'failed SVG decodes also revoke their object URL');
    await assert.rejects(module.exports.imageAsPng(`/kb-images/${id}`, async () => { throw new Error('Image not found'); }), /Image not found/);
    await assert.rejects(module.exports.imageAsPng(`/kb-images/${id}`, async () => new Blob(['not an image'], { type: 'text/html' })), /did not return an image/);
});
