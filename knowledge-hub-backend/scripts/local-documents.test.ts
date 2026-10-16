import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { listLocalIndex, localSourceId, parseLocalUploadFields, removeLocalDocuments } from '../src/services/localDocuments.js';
import { executeLocalFileTool, folderFor, normaliseWindowsPath, parseLocalFolders, type LocalFileWriteProposal } from '../src/ai/localFiles.js';

const deviceId = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const hash = 'a'.repeat(64);
const localKey = `${deviceId}:${'b'.repeat(64)}`;

test('ordinary uploads have no local fields', () => {
  assert.equal(parseLocalUploadFields({ projectId: 'personal' }), null);
});

test('local upload fields are parsed and the device comes from the key', () => {
  const fields = parseLocalUploadFields({ localKey, localPath: 'C:\\Docs\\plan.md', localHash: hash, deviceName: ' LAPTOP ' });
  assert.deepEqual(fields, { localKey, localPath: 'C:\\Docs\\plan.md', localHash: hash, deviceId, deviceName: 'LAPTOP' });
  assert.equal(localSourceId(localKey), `local:${localKey}`);
});

test('partial or malformed local fields are rejected, not treated as an ordinary upload', () => {
  assert.throws(() => parseLocalUploadFields({ localKey }), /localPath/);
  assert.throws(() => parseLocalUploadFields({ localKey: 'x:y', localPath: 'a', localHash: hash, deviceName: 'PC' }), /localKey/);
  assert.throws(() => parseLocalUploadFields({ localKey, localPath: 'a', localHash: 'abc', deviceName: 'PC' }), /localHash/);
});

test('the index lists one device only and needs a valid device id', async () => {
  const params: unknown[][] = [];
  const db = { query: async (_sql: string, p: unknown[]) => {
    params.push(p);
    return { rows: [{ id: 'c1', metadata: { localKey, localPath: 'C:\\a.md', localHash: hash, blobPath: 'b1-a.md' } }] };
  } } as unknown as Pool;
  const entries = await listLocalIndex(db, deviceId);
  assert.deepEqual(params[0], [`local:${deviceId}:%`]);
  assert.deepEqual(entries, [{ localKey, localPath: 'C:\\a.md', localHash: hash, contentItemId: 'c1', blobPath: 'b1-a.md' }]);
  await assert.rejects(listLocalIndex(db, "x%' OR 1=1"), /deviceId/);
});

test('removal deletes graph nodes, rows and blobs in a transaction', async () => {
  const tx: string[] = [];
  const db = {
    query: async () => ({ rows: [{ id: 'c1', metadata: { blobPath: 'b1-a.md' } }] }),
    connect: async () => ({
      query: async (sql: string) => { tx.push(sql.split(' ').slice(0, 3).join(' ')); return { rows: [] }; },
      release: () => undefined,
    }),
  } as unknown as Pool;
  const blobs: string[] = [];
  const removed = await removeLocalDocuments(db, [localKey], async (b) => { blobs.push(b); });
  assert.equal(removed, 1);
  assert.deepEqual(tx, ['BEGIN', 'DELETE FROM nodes', 'DELETE FROM content_items', 'COMMIT']);
  assert.deepEqual(blobs, ['b1-a.md']);
  await assert.rejects(removeLocalDocuments(db, ['not-a-key'], async () => undefined), /localKeys/);
});

const folders = parseLocalFolders([{ name: 'Notes', path: 'C:\\Users\\Rich\\Notes' }, { name: 'bad', path: 'relative\\x' }, 'junk', { path: '\\\\nas\\share\\Docs' }]);

test('only absolute folders from the request are kept', () => {
  assert.deepEqual(folders, [
    { name: 'Notes', path: 'C:\\Users\\Rich\\Notes' },
    { name: '\\\\nas\\share\\Docs', path: '\\\\nas\\share\\Docs' },
  ]);
  assert.deepEqual(parseLocalFolders(undefined), []);
});

test('paths are matched case-insensitively and cannot climb out of a folder', () => {
  assert.equal(normaliseWindowsPath('C:/Users/Rich/./Notes/../Notes/a.md'), 'c:\\users\\rich\\notes\\a.md');
  assert.equal(normaliseWindowsPath('C:\\..\\x'), null);
  assert.equal(normaliseWindowsPath('\\\\nas\\share\\..\\other'), null);
  assert.equal(folderFor('c:\\users\\rich\\notes\\sub\\plan.md', folders)?.name, 'Notes');
  assert.equal(folderFor('C:\\Users\\Rich\\Notes\\..\\secret.txt', folders), null);
  assert.equal(folderFor('C:\\Users\\Rich\\NotesExtra\\a.md', folders), null);
  assert.equal(folderFor('C:\\Users\\Rich\\Notes', folders), null);
  assert.equal(folderFor('Notes\\a.md', folders), null);
  assert.equal(folderFor('\\\\nas\\share\\Docs\\x.md', folders)?.path, '\\\\nas\\share\\Docs');
});

test('writes are proposals inside an allowed folder, text files only', async () => {
  const db = {} as Pool;
  const writes: LocalFileWriteProposal[] = [];
  const ok = await executeLocalFileTool(db, 'propose_local_file_write', { path: 'C:\\Users\\Rich\\Notes\\plan.md', content: '# Plan', summary: 'New plan' }, folders, writes);
  assert.deepEqual(ok, { proposed: true, path: 'C:\\Users\\Rich\\Notes\\plan.md', note: 'Shown to him as a diff with Apply/Discard. It is not written until he applies it.' });
  assert.deepEqual(writes, [{ path: 'C:\\Users\\Rich\\Notes\\plan.md', content: '# Plan', summary: 'New plan' }]);
  assert.match(JSON.stringify(await executeLocalFileTool(db, 'propose_local_file_write', { path: 'C:\\Windows\\x.md', content: 'x' }, folders, writes)), /not inside/);
  assert.match(JSON.stringify(await executeLocalFileTool(db, 'propose_local_file_write', { path: 'C:\\Users\\Rich\\Notes\\a.exe', content: 'x' }, folders, writes)), /Only text files/);
  assert.match(JSON.stringify(await executeLocalFileTool(db, 'read_local_file', { path: 'C:\\Users\\Rich\\Notes\\a.md' }, [], writes)), /only available in Athena Desktop/);
  assert.equal(writes.length, 1);
});

test('reads return the indexed copy of the file', async () => {
  const params: unknown[][] = [];
  const db = { query: async (_sql: string, p: unknown[]) => {
    params.push(p);
    return { rows: [{ id: 'c1', title: 'plan', body: 'hello', local_path: 'C:\\Users\\Rich\\Notes\\plan.md' }] };
  } } as unknown as Pool;
  const result = await executeLocalFileTool(db, 'read_local_file', { path: 'c:/users/rich/notes/plan.md' }, folders, []);
  assert.deepEqual(params[0], ['c:\\users\\rich\\notes\\plan.md']);
  assert.deepEqual(result, { path: 'C:\\Users\\Rich\\Notes\\plan.md', title: 'plan', contentItemId: 'c1', text: 'hello', truncated: false });
});
