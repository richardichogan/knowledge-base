import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECENT_KEY, chatHref, isExternalHref, pushRecent, readRecent, type PaletteTarget } from '../src/components/commandPaletteItems';

function memoryStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(RECENT_KEY, initial);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

const target = (id: string, kind: PaletteTarget['kind'] = 'note'): PaletteTarget => ({ kind, id, title: `Item ${id}`, href: `/think?noteId=${id}` });

test('recent palette items are most-recent first, de-duplicated by kind and id, and capped', () => {
  const storage = memoryStorage();
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) pushRecent(storage, target(id));
  assert.deepEqual(readRecent(storage).map(item => item.id), ['7', '6', '5', '4', '3', '2']);

  pushRecent(storage, target('4'));
  assert.deepEqual(readRecent(storage).map(item => item.id), ['4', '7', '6', '5', '3', '2']);

  pushRecent(storage, target('4', 'project'));
  assert.deepEqual(readRecent(storage).slice(0, 2).map(item => `${item.kind}:${item.id}`), ['project:4', 'note:4']);
});

test('recent palette items tolerate bad or missing storage', () => {
  assert.deepEqual(readRecent(memoryStorage('not json')), []);
  assert.deepEqual(readRecent(memoryStorage('{"kind":"note"}')), []);
  assert.deepEqual(readRecent(memoryStorage(JSON.stringify([{ kind: 'bogus', id: 'x', title: 'x', href: '/' }, target('ok')]))).map(item => item.id), ['ok']);
  assert.deepEqual(readRecent(undefined), []);
  assert.deepEqual(pushRecent(undefined, target('a')).map(item => item.id), ['a']);
});

test('palette hrefs distinguish chats and external links', () => {
  assert.equal(chatHref('a b'), '/chat?session=a%20b');
  assert.equal(isExternalHref('https://example.com'), true);
  assert.equal(isExternalHref('/think?noteId=1'), false);
});
