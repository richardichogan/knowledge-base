import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FolderRegistry, folderContaining, guardPath, localKey, type LocalFolder } from '../src/folders';
import { readText, writeText } from '../src/fileAccess';
import { classifyUrl, isAthenaFrame } from '../src/navigation';
import { Scanner } from '../src/scanner';

const ORIGIN = 'https://athena.example.com';

describe('navigation', () => {
  it('keeps Athena pages in the app and sends other sites to the browser', () => {
    assert.equal(classifyUrl('https://athena.example.com/chat?x=1', ORIGIN), 'athena');
    assert.equal(classifyUrl('https://login.microsoftonline.com/common/oauth2', ORIGIN), 'sign-in');
    assert.equal(classifyUrl('about:blank', ORIGIN), 'blank');
    assert.equal(classifyUrl('https://example.org', ORIGIN), 'external');
    assert.equal(classifyUrl('https://athena.example.com.evil.net/', ORIGIN), 'external');
    assert.equal(classifyUrl('http://login.microsoftonline.com/', ORIGIN), 'external');
    assert.equal(classifyUrl('file:///C:/Windows/win.ini', ORIGIN), 'deny');
    assert.equal(classifyUrl('javascript:alert(1)', ORIGIN), 'deny');
  });

  it('only trusts frames from the Athena origin', () => {
    assert.equal(isAthenaFrame('https://athena.example.com/library', ORIGIN), true);
    assert.equal(isAthenaFrame('https://login.microsoftonline.com/', ORIGIN), false);
    assert.equal(isAthenaFrame(undefined, ORIGIN), false);
    assert.equal(isAthenaFrame('not a url', ORIGIN), false);
  });

  it('keeps Microsoft security registration in the sign-in window without granting file access', () => {
    const registration = 'https://mysignins.microsoft.com/api/post/registerSsprMethods?returl=fixture';
    assert.equal(classifyUrl(registration, ORIGIN), 'sign-in');
    assert.equal(isAthenaFrame(registration, ORIGIN), false);
    assert.equal(classifyUrl('http://mysignins.microsoft.com/', ORIGIN), 'external');
    assert.equal(classifyUrl('https://mysignins.microsoft.com.evil.example/', ORIGIN), 'external');
  });
});

describe('folders', () => {
  let root: string;
  let allowed: string;
  let outside: string;
  let folders: LocalFolder[];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'athena-desktop-'));
    allowed = join(root, 'Allowed');
    outside = join(root, 'Outside');
    await mkdir(join(allowed, 'sub'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(allowed, 'notes.md'), '# Notes');
    await writeFile(join(outside, 'secret.md'), 'secret');
    folders = [{ id: 'f1', name: 'Allowed', path: allowed }];
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  it('rejects paths outside the folders, including .. tricks and the folder itself', async () => {
    assert.equal(folderContaining(join(allowed, 'notes.md'), folders)?.id, 'f1');
    assert.equal(folderContaining(join(allowed, '..', 'Outside', 'secret.md'), folders), null);
    assert.equal(folderContaining(allowed, folders), null);
    assert.equal(folderContaining('notes.md', folders), null);
    assert.equal(folderContaining(allowed + 'Sibling\\a.md', folders), null);
    await assert.rejects(guardPath(join(outside, 'secret.md'), folders), /does not have access/);
  });

  it('matches paths case-insensitively on Windows', { skip: process.platform !== 'win32' }, () => {
    assert.equal(folderContaining(join(allowed.toUpperCase(), 'NOTES.MD'), folders)?.id, 'f1');
  });

  it('blocks junctions that point outside the folder, for existing and new files', async (t) => {
    const link = join(allowed, 'escape');
    try {
      await symlink(outside, link, 'junction');
    } catch {
      t.skip('junctions not available');
      return;
    }
    await assert.rejects(guardPath(join(link, 'secret.md'), folders), /links outside/);
    await assert.rejects(guardPath(join(link, 'new', 'file.md'), folders), /links outside/);
    await assert.rejects(writeText(join(link, 'new.md'), 'x', folders), /links outside/);
  });

  it('reads and writes text inside the folder only', async () => {
    assert.equal(await readText(join(allowed, 'notes.md'), folders), '# Notes');
    assert.equal(await readText(join(allowed, 'missing.md'), folders), null);
    await writeText(join(allowed, 'sub', 'deeper', 'plan.md'), 'plan', folders);
    assert.equal(await readFile(join(allowed, 'sub', 'deeper', 'plan.md'), 'utf8'), 'plan');
    await assert.rejects(writeText(join(allowed, 'report.docx'), 'x', folders), /only write text files/);
    await assert.rejects(writeText(join(outside, 'x.md'), 'x', folders), /does not have access/);
  });

  it('gives each file a stable key that ignores case', () => {
    const a = localKey('dev', 'C:\\Docs\\Plan.md');
    assert.equal(a, localKey('dev', 'c:\\docs\\plan.md'));
    assert.notEqual(a, localKey('other', 'C:\\Docs\\Plan.md'));
    assert.match(a, /^dev:[0-9a-f]{64}$/);
  });

  it('remembers folders, keeps the device id, and refuses overlaps', async () => {
    const file = join(root, 'folders.json');
    const reg = new FolderRegistry(file);
    const { deviceId } = await reg.load();
    const added = await reg.add(allowed);
    assert.equal((await reg.add(allowed)).id, added.id);
    await assert.rejects(reg.add(join(allowed, 'sub')), /overlaps/);
    const again = new FolderRegistry(file);
    assert.equal((await again.load()).deviceId, deviceId);
    assert.deepEqual((await again.folders()).map((f) => f.path), [allowed]);
    assert.equal((await again.remove(added.id))?.id, added.id);
    assert.deepEqual(await again.folders(), []);
  });

  it('scans supported files, skips lock files and hidden folders, and hashes content', async () => {
    await mkdir(join(allowed, '.git'), { recursive: true });
    await writeFile(join(allowed, '.git', 'hidden.md'), 'x');
    await writeFile(join(allowed, '~$notes.docx'), 'lock');
    await writeFile(join(allowed, 'image.png'), 'png');
    const scanner = new Scanner();
    const first = await scanner.scan('dev', folders);
    const names = first.files.map((f) => f.path.slice(allowed.length + 1)).sort();
    assert.ok(names.includes('notes.md'));
    assert.ok(!names.some((n) => n.includes('.git') || n.includes('~$') || n.endsWith('.png')));
    const notes = first.files.find((f) => f.path.endsWith('notes.md'));
    assert.match(notes?.hash ?? '', /^[0-9a-f]{64}$/);
    await writeFile(join(allowed, 'notes.md'), '# Notes changed');
    const second = await scanner.scan('dev', folders);
    assert.notEqual(second.files.find((f) => f.path.endsWith('notes.md'))?.hash, notes?.hash);
  });
});
