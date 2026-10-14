import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { findEarlierPosts, generateBlogDraft, keepAllowedLinks } from '../src/ai/blogDraft.js';

const source = { title: 'Copilot plugin registry', body: 'Microsoft announced a plugin registry for Copilot.', source: 'discovered-article', url: 'https://example.com/news' } as const;
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const reply = (title: string, n: number, extra = '') => JSON.stringify({
  title, excerpt: 'Hook.', summary: 'The registry is an admin story.', content: `<p>${words(n)}${extra}</p>`,
  keyTakeaways: ['One.', 'Two.', 'Three.'], categories: ['AI & Copilot', 'Quick Take'], tags: ['Copilot'],
});

test('quick take is regenerated once when too long, capped to two takeaways and typed as quick', async () => {
  const prompts: string[] = [];
  const replies = [reply('A title that is far too long for a quick take on this blog site', 700), reply('Registry is an admin story', 400)];
  const client = { chat: async (_m: string, msgs: Array<{ content: string }>) => { prompts.push(msgs[0]!.content); return replies.shift()!; } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client as never);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /QUICK TAKE/);
  assert.match(prompts[1]!, /broke the limits \(700 words, title 63 characters\)/);
  assert.equal(draft.postType, 'quick');
  assert.equal(draft.title, 'Registry is an admin story');
  assert.deepEqual(draft.keyTakeaways, ['One.', 'Two.']);
  assert.deepEqual(draft.categories, ['AI & Copilot']);
});

test('quick take keeps only the source and supplied earlier-post links', async () => {
  const extra = ' <a href="https://example.com/news">source</a> <a href="https://themicrosoftcloudblog.com/2026/01/old/">old</a> <a href="https://invented.example/x">made up</a>';
  const client = { chat: async () => reply('Registry is an admin story', 350, extra) };
  const draft = await generateBlogDraft(source, source.url, 'short', [{ title: 'Old', url: 'https://themicrosoftcloudblog.com/2026/01/old/' }], client as never);
  assert.match(draft.content, /href="https:\/\/example.com\/news">source/);
  assert.match(draft.content, /2026\/01\/old\/">old/);
  assert.doesNotMatch(draft.content, /invented/);
  assert.match(draft.content, /made up/);
  assert.equal(keepAllowedLinks('<a href="x">y</a>', []), 'y');
});

test('long posts keep the article format with no regeneration', async () => {
  let calls = 0;
  const client = { chat: async () => { calls++; return reply('Long title', 800); } };
  const draft = await generateBlogDraft(source, source.url, 'long', [], client as never);
  assert.equal(calls, 1);
  assert.equal(draft.postType, 'article');
  assert.equal(draft.keyTakeaways.length, 3);
});

test('earlier posts are ranked by overlap with the source and limited to blog posts', async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE content_items (source text, title text, summary text NOT NULL DEFAULT '', url text, tags text[] NOT NULL DEFAULT '{}');
    INSERT INTO content_items VALUES
      ('cms-blog', 'Copilot extensibility needs governance', 'plugins and admins', 'https://blog/a', '{Copilot,plugins}'),
      ('cms-blog', 'Azure landing zones', 'networking', 'https://blog/b', '{Azure}'),
      ('discovered-article', 'Copilot plugin registry news', '', 'https://news/c', '{Copilot}');`);
  const posts = await findEarlierPosts(db as unknown as Pool, 'Copilot plugin registry for admins');
  assert.deepEqual(posts, [{ title: 'Copilot extensibility needs governance', url: 'https://blog/a' }]);
  assert.deepEqual(await findEarlierPosts(db as unknown as Pool, '!!'), []);
});
