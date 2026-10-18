import assert from 'node:assert/strict';
import { test } from 'node:test';
import { debouncedLinkSearch, entityLinkHref, wikiQuery } from '../src/notes/entityLinks';

test('entity routes encode stable IDs and wiki queries remove only closing delimiters', () => {
  assert.equal(entityLinkHref('project', 'work & research'), '/projects?projectId=work%20%26%20research');
  assert.equal(entityLinkHref('note', 'abc'), '/think?noteId=abc');
  assert.equal(entityLinkHref('spark', 'abc'), '/think?view=sparks&sparkId=abc');
  assert.equal(entityLinkHref('diagram', 'abc'), '/think?mapId=abc');
  assert.deepEqual(wikiQuery('Product roadmap]]'), { text: 'Product roadmap', closed: true });
  assert.deepEqual(wikiQuery('Product roadmap'), { text: 'Product roadmap', closed: false });
});

test('suggestions debounce keystrokes, settle superseded callers, suppress stale responses and expose errors', async () => {
  const called: string[] = [];
  const search = debouncedLinkSearch(async query => { called.push(query); return [query]; }, 10);
  const first = search.run('r');
  const second = search.run('ro');
  const third = search.run('road');
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
  assert.deepEqual(await third, ['road']);
  assert.deepEqual(called, ['road'], 'a typing burst makes one request, not one request per key');
  search.dispose();
  let release: ((items: string[]) => void) | undefined;
  const held = debouncedLinkSearch(query => query === 'old' ? new Promise<string[]>(resolve => { release = resolve; }) : Promise.resolve([query]), 0);
  const old = held.run('old');
  await new Promise(resolve => setTimeout(resolve, 10));
  const latest = held.run('new');
  release?.(['stale']);
  assert.deepEqual(await old, []);
  assert.deepEqual(await latest, ['new']);
  held.dispose();
  const failing = debouncedLinkSearch(async () => { throw new Error('Search unavailable'); }, 0);
  await assert.rejects(failing.run('query'), /Search unavailable/);
  const disposed = failing.run('pending');
  failing.dispose();
  assert.deepEqual(await disposed, []);
});
