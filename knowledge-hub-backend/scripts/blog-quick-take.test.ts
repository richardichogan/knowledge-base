import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { findEarlierPosts, generateBlogDraft, keepAllowedLinks } from '../src/ai/blogDraft.js';
import { findTropes, fixDashes } from '../src/ai/styleCheck.js';

const source = { title: 'Copilot plugin registry', body: 'Microsoft announced a plugin registry for Copilot.', source: 'discovered-article', url: 'https://example.com/news' } as const;
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const reply = (title: string, n: number, extra = '') => JSON.stringify({
  title, excerpt: 'Hook.', summary: 'The registry is an admin story.', content: `<p>${words(n)}${extra}</p>`,
  keyTakeaways: ['One.', 'Two.', 'Three.'], categories: ['AI', 'Copilot', 'Quick Take'], tags: ['Copilot'],
});

test('quick take is regenerated once when too long, capped to two takeaways and typed as quick', async () => {
  const prompts: string[] = [];
  const replies = [reply('A title that is far too long for a quick take on this blog site', 700), JSON.stringify({
    replacements: [{ id: 0, text: 'Registry is an admin story' }, { id: 1, text: `<p>${words(400)}</p>` }],
  })];
  const client = { chat: async (_m: string, msgs: Array<{ content: string }>) => { prompts.push(msgs.map(m => m.content).join('\n')); return replies.shift()!; } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client as never);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /QUICK TAKE/);
  assert.match(prompts[1]!, /Use at most 60 characters/);
  assert.match(prompts[1]!, /Reduce the body to 300 to 450 words/);
  assert.equal(draft.postType, 'quick');
  assert.equal(draft.title, 'Registry is an admin story');
  assert.deepEqual(draft.keyTakeaways, ['One.', 'Two.']);
  assert.deepEqual(draft.categories, ['AI', 'Copilot']);
});

test('quick take keeps the source link only in the footer and retains supplied earlier-post links', async () => {
  const extra = ' <a href="https://example.com/news">source</a> <a href="https://themicrosoftcloudblog.com/2026/01/old/">old</a> <a href="https://invented.example/x">made up</a>';
  const client = { chat: async () => reply('Registry is an admin story', 350, extra) };
  const draft = await generateBlogDraft(source, source.url, 'short', [{ title: 'Old', url: 'https://themicrosoftcloudblog.com/2026/01/old/' }], client as never);
  assert.doesNotMatch(draft.content.split('<hr>')[0]!, /href="https:\/\/example.com\/news"/);
  assert.match(draft.content, /Source: <a href="https:\/\/example.com\/news">Copilot plugin registry/);
  assert.match(draft.content, /2026\/01\/old\/">old/);
  assert.doesNotMatch(draft.content, /invented/);
  assert.match(draft.content, /made up/);
  assert.equal(keepAllowedLinks('<a href="x">y</a>', []), 'y');
});

test('style repairs fix the logged triplet without rewriting clean passages', async () => {
  const clean = '<p>Microsoft announced the registry.</p>';
  const bad = '<p>Build with clear policy objects, audit evidence, and failure modes that security can inspect.</p>';
  const fixed = '<p>Define clear policy objects. Retain audit evidence and document failure modes for security review.</p>';
  let calls = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...JSON.parse(reply('Registry review', 350)), content: clean + bad });
    const request = JSON.parse(messages[1]!.content);
    assert.equal(request.passages.length, 1);
    assert.equal(request.passages[0].text, bad);
    assert.match(request.passages[0].problems.join(' '), /triplet list/);
    return JSON.stringify({ replacements: [{ id: 0, text: fixed }] });
  } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(calls, 2);
  assert.equal(draft.content.split('\n<hr>')[0], clean + fixed);
  assert.deepEqual(findTropes(draft.content), []);
});

test('subsequent repairs retain clean replacements and never return a failing draft', async () => {
  let calls = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    calls++;
    if (calls === 1) return JSON.stringify({
      ...JSON.parse(reply('Registry review', 350)),
      content: '<p>This is load-bearing.</p><p>It is a game-changer.</p>',
    });
    const { passages } = JSON.parse(messages[1]!.content);
    if (calls === 2) return JSON.stringify({ replacements: [
      { id: 0, text: '<p>The registry records permissions.</p>' },
      { id: 1, text: '<p>It is pivotal.</p>' },
    ] });
    assert.equal(passages.length, 1);
    assert.equal(passages[0].text, '<p>It is pivotal.</p>');
    return JSON.stringify({ replacements: [{ id: 0, text: '<p>It is pivotal.</p>' }] });
  } };
  await assert.rejects(generateBlogDraft(source, source.url, 'short', [], client), /could not produce a draft/);
  assert.equal(calls, 6);
});

test('style detection reports all occurrences without combining independent fields', () => {
  assert.deepEqual(findTropes('One.', 'Two.', 'Three.'), []);
  const found = findTropes('Load-bearing. This is pivotal. It is seamless.');
  assert.equal(found.filter(issue => issue.startsWith('stock AI phrasing:')).length, 3);
  assert.ok(findTropes('The useful bit is not the demo polish, it is the assumption underneath.').some(issue => issue.includes('construction')));
  assert.ok(findTropes('Identity, data protection, and threat information need the same control path.').some(issue => issue.includes('triplet')));
  assert.equal(fixDashes('<a href="https://example.com/a–b">Review — today</a>'),
    '<a href="https://example.com/a–b">Review — today</a>');
  assert.equal(fixDashes('<p>Review — today</p>'), '<p>Review, today</p>');
});

test('introductory clauses followed by two items do not trigger triplet repairs', async () => {
  const sentences = [
    'In enterprise IT, identity and permissions now travel with the agent.',
    'Before deployment, admins and developers review access.',
    'For security teams, audit evidence and permissions need review.',
    'With logging enabled, errors and warnings appear in the console.',
  ];
  for (const sentence of sentences) assert.deepEqual(findTropes(sentence), [], sentence);
  for (const sentence of [
    'Engineering process, policy, and evidence already meet.',
    'Build with clear policy objects, audit evidence, and failure modes that security can inspect.',
    'Identity, data protection, and threat information need the same control path.',
    'Check later scans, separate tooling, or a developer remembering the task.',
    'Faster. Cheaper. Safer.',
  ]) assert.ok(findTropes(sentence).some(issue => issue.includes('triplet')), sentence);

  const content = sentences.map(sentence => `<p>${sentence}</p>`).join('');
  let calls = 0;
  const client = { chat: async () => {
    calls++;
    assert.equal(calls, 1, 'A clean draft must not enter the repair loop');
    return JSON.stringify({ ...JSON.parse(reply('Agent permissions', 350)), content });
  } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(draft.content.split('\n<hr>')[0], content);
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
