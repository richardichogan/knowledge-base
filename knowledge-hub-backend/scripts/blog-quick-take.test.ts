import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { blogEvidence, findEarlierPosts, generateBlogDraft, keepAllowedLinks, readBlogSource } from '../src/ai/blogDraft.js';
import { findTropes, fixDashes } from '../src/ai/styleCheck.js';
import { AiOutputLimitError } from '../src/types/errors.js';

const source = { title: 'Copilot plugin registry', body: 'Microsoft announced a plugin registry for Copilot.', source: 'discovered-article', url: 'https://example.com/news' } as const;
const words = (n: number) => Array.from({ length: n }, (_, index) => index % 20 === 19 ? 'word.' : 'word').join(' ');
const reply = (title: string, n: number, extra = '') => JSON.stringify({
  title, excerpt: 'Hook.', summary: 'The registry is an admin story.', content: `<p>${words(n)}${extra}</p>`,
  keyTakeaways: ['One.', 'Two.', 'Three.'], categories: ['AI', 'Copilot', 'Quick Take'], tags: ['Copilot'],
});
const verified = JSON.stringify({ findings: [] });

test('related links are not treated as source evidence', () => {
  const source = { title: 'Source', body: 'Source facts.', earlierPosts: [{ title: 'Related', url: 'https://example.test/related' }] };
  assert.deepEqual(JSON.parse(blogEvidence(JSON.stringify(source))), { title: source.title, body: source.body });
});

test('direct generation sends only the flagged sentence to the editor', async () => {
  const before = 'This is a game-changer.';
  const clean = 'Administrators can inspect permissions.';
  let corrections = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>, _tokens?: number, _timeout?: number, _signal?: AbortSignal, schema?: { name: string }) => {
    if (schema?.name === 'blog_draft') return JSON.stringify({ ...JSON.parse(reply('Registry review', 350)), content: `<p>${clean} ${before}</p>` });
    if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
    const request = JSON.parse(messages[1]!.content);
    if (schema?.name === 'blog_review_findings' && messages[0]!.content.includes('Review style')) {
      const passage = request.passages.find((entry: { field: string; before: string }) =>
        entry.field === 'content' && entry.before === before);
      return passage ? JSON.stringify({ findings: [{ id: passage.id, reason: 'Stock wording', kind: 'style', claim: '', contradiction: '', sourceIds: [] }] }) : verified;
    }
    if (schema?.name === 'blog_passage_edits') {
      corrections++;
      assert.doesNotMatch(messages[1]!.content, /Administrators can inspect permissions/);
      return JSON.stringify({ edits: [{ id: request.findings[0].id, after: 'The registry changes the process.', remove: '' }] });
    }
    return verified;
  } };
  const result = await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(result.content.split('\n<hr>')[0], `<p>${clean} The registry changes the process.</p>`);
  assert.equal(corrections, 1);
});

test('a clipped candidate response is retried once without changing the generation request', async () => {
  const calls: Array<{ messages: unknown; tokens: number | undefined }> = [];
  const client = { chat: async (_model: string, messages: Array<{ content: string }>, tokens?: number, _timeout?: number, _signal?: AbortSignal, schema?: { name: string }) => {
    if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
    calls.push({ messages, tokens });
    if (calls.length === 1) throw new AiOutputLimitError();
    if (calls.length === 2) {
      assert.deepEqual(messages, calls[0]!.messages);
      assert.equal(tokens, calls[0]!.tokens! * 2);
      return reply('Registry preview', 350);
    }
    return verified;
  } };
  await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(calls.length, 4);
  let failures = 0;
  await assert.rejects(generateBlogDraft(source, source.url, 'short', [], { chat: async () => {
    failures++;
    throw new AiOutputLimitError();
  } }), AiOutputLimitError);
  assert.equal(failures, 2);
});

test('quick take keeps the source link only in the footer and retains supplied earlier-post links', async () => {
  const extra = ' <a href="https://example.com/news">source</a> <a href="https://themicrosoftcloudblog.com/2026/01/old/">old</a> <a href="https://invented.example/x">made up</a>';
  let calls = 0;
  const client = { chat: async (_model: string, _messages: unknown, _tokens?: number, _timeout?: number, _signal?: AbortSignal, schema?: { name: string }) => {
    if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
    return ++calls === 1 ? reply('Registry is an admin story', 350, extra) : verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'short', [{ title: 'Old', url: 'https://themicrosoftcloudblog.com/2026/01/old/' }], client as never);
  assert.doesNotMatch(draft.content.split('<hr>')[0]!, /href="https:\/\/example.com\/news"/);
  assert.match(draft.content, /Source: <a href="https:\/\/example.com\/news">Copilot plugin registry/);
  assert.match(draft.content, /2026\/01\/old\/">old/);
  assert.doesNotMatch(draft.content, /invented/);
  assert.match(draft.content, /made up/);
  assert.equal(keepAllowedLinks('<a href="x">y</a>', []), 'y');
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
  const client = { chat: async (_model: string, _messages: unknown, _tokens?: number, _timeout?: number, _signal?: AbortSignal, schema?: { name: string }) => {
    if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
    calls++;
    return calls === 1 ? JSON.stringify({ ...JSON.parse(reply('Agent permissions', 350)), content }) : verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(draft.content.split('\n<hr>')[0], content);
  assert.equal(calls, 3, 'Clean copy receives fact and style review without a rewrite');
});

test('long posts keep the article format with no regeneration', async () => {
  let calls = 0;
  const client = { chat: async (_model: string, _messages: unknown, _tokens?: number, _timeout?: number, _signal?: AbortSignal, schema?: { name: string }) => {
    if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
    return ++calls === 1 ? reply('Long title', 800) : verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'long', [], client as never);
  assert.equal(calls, 3);
  assert.equal(draft.postType, 'article');
  assert.equal(draft.keyTakeaways.length, 3);
});

test('manual article drafting reads source evidence and never silently falls back to a feed description', async () => {
  const full = 'Full source evidence describing preview availability.';
  assert.equal((await readBlogSource(source, async url => {
    assert.equal(url, source.url);
    return { title: source.title, text: full };
  })).body, full);
  await assert.rejects(readBlogSource(source, async () => { throw new Error('Source unavailable'); }), /Source unavailable/);
  await assert.rejects(readBlogSource(source, async () => ({ title: '', text: 'Verify you are human' })), /could not be read/);
  const email = { ...source, source: 'email' };
  assert.equal(await readBlogSource(email, async () => { throw new Error('Email must not trigger a page read'); }), email);
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
