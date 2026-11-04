import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import type { NoteEdit, NoteEditDeliveryResult } from '../src/types/ai';

async function fixture() {
  const receipts = new Map<string, string>();
  const harness = {
    identity: 'test-account', noteId: 'note', applied: 0, protect: false,
    result: { applied: 1, failed: [] as string[] }, saved: Promise.resolve(),
  };
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/utils/noteEditDelivery.ts', import.meta.url))],
    bundle: true, write: false, format: 'cjs', platform: 'browser', logLevel: 'silent',
    plugins: [{
      name: 'live-editor-fixture',
      setup(builder) {
        builder.onResolve({ filter: /(?:services\/auth|activeBlockNoteEditor|noteEditApplier)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
          args.path.endsWith('auth') ? 'export const noteDraftIdentity = { get: () => globalThis.harness.identity };'
            : args.path.endsWith('noteEditApplier') ? 'export function applyNoteEdits() { globalThis.harness.applied++; return globalThis.harness.result; }'
              : `export const getActiveBlockNoteEditor = () => ({});
                 export const getActiveNoteId = () => globalThis.harness.noteId;
                 export const isActiveScriptEditor = () => false;
                 export async function runNoteAction(id, protect, action) {
                   globalThis.harness.protect = protect; action(); await globalThis.harness.saved;
                 }`,
        }));
      },
    }],
  });
  const module = { exports: {} };
  const sandbox = createContext({
    module, exports: module.exports, harness, Error,
    console: { error: () => {} },
    sessionStorage: {
      getItem: (key: string) => receipts.get(key) ?? null,
      setItem: (key: string, value: string) => { receipts.set(key, value); },
    },
  });
  runInContext(bundled.outputFiles[0]!.text, sandbox);
  const deliver = (module.exports as {
    deliverNoteEdits: (messageId: string | undefined, noteId: string, edits: NoteEdit[]) => Promise<NoteEditDeliveryResult>;
  }).deliverNoteEdits;
  const edits: NoteEdit[] = [{ action: 'append', markdown: 'Requested writing.', summary: 'Append writing' }];
  return { harness, receipts, deliver, edits };
}

test('direct note edits await the protected save and deliver a live turn only once', async () => {
  const { harness, deliver, edits } = await fixture();
  let release: (() => void) | undefined;
  harness.saved = new Promise<void>(resolve => { release = resolve; });
  let complete = false;
  const first = deliver('reply', 'note', edits).then(result => { complete = true; return result; });
  const duplicate = deliver('reply', 'note', edits);
  await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(harness.applied, 1);
  assert.equal(harness.protect, true);
  release!();
  assert.equal((await first).state, 'saved');
  assert.equal((await duplicate).state, 'saved');
  assert.equal((await deliver('reply', 'note', edits)).state, 'saved');
  assert.equal(harness.applied, 1);
});

test('a started delivery without a save receipt is not replayed after reconnect', async () => {
  const { harness, receipts, deliver, edits } = await fixture();
  receipts.set('athena-note-edit:test-account:note:reply', JSON.stringify({ state: 'applying' }));
  const result = await deliver('reply', 'note', edits);
  assert.equal(result.state, 'blocked');
  assert.match(result.error ?? '', /not been applied again/);
  assert.equal(harness.applied, 0);
});

test('missing targets, identities and stable message IDs cannot mutate the editor', async () => {
  const { harness, deliver, edits } = await fixture();
  assert.equal((await deliver(undefined, 'note', edits)).state, 'blocked');
  harness.noteId = 'different-note';
  assert.equal((await deliver('reply', 'note', edits)).state, 'blocked');
  harness.identity = '';
  assert.equal((await deliver('another-reply', 'note', edits)).state, 'blocked');
  assert.equal(harness.applied, 0);
});

test('partial edits and failed saves are reported accurately and never replayed', async () => {
  const { harness, deliver, edits } = await fixture();
  harness.result = { applied: 1, failed: ['The second passage changed.'] };
  const partial = await deliver('partial', 'note', edits);
  assert.equal(partial.state, 'partial');
  assert.equal(partial.failed[0], harness.result.failed[0]);
  harness.saved = Promise.reject(new Error('Revision conflict: draft retained.'));
  const failed = await deliver('failed', 'note', edits);
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.applied, 1);
  assert.match(failed.error ?? '', /Revision conflict/);
  assert.equal((await deliver('failed', 'note', edits)).state, 'blocked');
  assert.equal(harness.applied, 2);
});
