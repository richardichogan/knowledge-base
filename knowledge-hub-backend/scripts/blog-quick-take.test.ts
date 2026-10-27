import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { findEarlierPosts, generateBlogDraft, keepAllowedLinks, readBlogSource } from '../src/ai/blogDraft.js';
import { findTropes, fixDashes } from '../src/ai/styleCheck.js';
import { AiOutputLimitError } from '../src/types/errors.js';

const source = { title: 'Copilot plugin registry', body: 'Microsoft announced a plugin registry for Copilot.', source: 'discovered-article', url: 'https://example.com/news' } as const;
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const reply = (title: string, n: number, extra = '') => JSON.stringify({
  title, excerpt: 'Hook.', summary: 'The registry is an admin story.', content: `<p>${words(n)}${extra}</p>`,
  keyTakeaways: ['One.', 'Two.', 'Three.'], categories: ['AI', 'Copilot', 'Quick Take'], tags: ['Copilot'],
});
const verified = JSON.stringify({ edits: [] });
const edit = (field: string, before: string, alternatives: string[], kind = 'style') =>
  ({ field, before, alternatives, kind, reason: 'Correct the identified defect using the supplied source.' });

test('quick take is shortened locally, verified, capped to two takeaways and typed as quick', async () => {
  const prompts: string[] = [];
  const title = 'A title that is far too long for a quick take on this blog site';
  const replies = [reply(title, 700), JSON.stringify({ edits: [
    edit('title', title, ['Registry is an admin story'], 'length'),
    edit('content', `<p>${words(700)}</p>`, [`<p>${words(400)}</p>`], 'length'),
  ] }), verified];
  const client = { chat: async (_m: string, msgs: Array<{ content: string }>) => { prompts.push(msgs.map(m => m.content).join('\n')); return replies.shift()!; } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client as never);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0]!, /QUICK TAKE/);
  assert.match(prompts[1]!, /use at most 60/);
  assert.match(prompts[1]!, /reduce it to 300 to 450 words/);
  assert.equal(draft.postType, 'quick');
  assert.equal(draft.title, 'Registry is an admin story');
  assert.deepEqual(draft.keyTakeaways, ['One.', 'Two.']);
  assert.deepEqual(draft.categories, ['AI', 'Copilot']);
});

test('quick take keeps the source link only in the footer and retains supplied earlier-post links', async () => {
  const extra = ' <a href="https://example.com/news">source</a> <a href="https://themicrosoftcloudblog.com/2026/01/old/">old</a> <a href="https://invented.example/x">made up</a>';
  let calls = 0;
  const client = { chat: async () => ++calls === 1 ? reply('Registry is an admin story', 350, extra) : verified };
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
    if (calls === 3) return verified;
    const request = JSON.parse(messages[1]!.content);
    assert.equal(request.draft.content, clean + bad);
    assert.match(request.problems.join(' '), /triplet list/);
    return JSON.stringify({ edits: [edit('content', bad, [fixed])] });
  } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(calls, 3);
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
    const request = JSON.parse(messages[1]!.content);
    if (calls === 2) return JSON.stringify({ edits: [
      edit('content', '<p>This is load-bearing.</p>', ['<p>The registry records permissions.</p>']),
      edit('content', '<p>It is a game-changer.</p>', ['<p>It is pivotal.</p>']),
    ] });
    assert.equal(request.draft.content, '<p>The registry records permissions.</p><p>It is a game-changer.</p>');
    assert.ok(request.previousRejections.length > 0);
    return JSON.stringify({ edits: [edit('content', '<p>It is a game-changer.</p>', ['<p>It is pivotal.</p>'])] });
  } };
  await assert.rejects(generateBlogDraft(source, source.url, 'short', [], client), /verification could not be completed safely/);
  assert.equal(calls, 8);
});

test('repairing one sentence accepts changed scanner context around an existing neighbouring defect', async () => {
  const before = 'Use policy checks, access logs, and freshness controls for memory, retrieval, and deletion.';
  const intermediate = 'Use policy checks and access logs. Apply freshness controls for memory, retrieval, and deletion.';
  const after = 'Use policy checks and access logs. Apply freshness controls to memory. Check retrieval and deletion separately.';
  let calls = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...JSON.parse(reply('Memory controls', 800)), content: `<p>${before}</p>` });
    const request = JSON.parse(messages[1]!.content);
    if (calls === 2) return JSON.stringify({ edits: [edit('content', before, [intermediate], 'accuracy')] });
    assert.equal(request.previousRejections.length, 0);
    if (calls === 3) {
      assert.equal(request.draft.content, `<p>${intermediate}</p>`);
      return JSON.stringify({ edits: [edit('content', 'Apply freshness controls for memory, retrieval, and deletion.',
        ['Apply freshness controls to memory. Check retrieval and deletion separately.'])] });
    }
    return verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'long', [], client);
  assert.equal(draft.content.split('\n<hr>')[0], `<p>${after}</p>`);
  assert.equal(calls, 4);
});

test('a contrast spanning two sentences is repaired as one offending construction', async () => {
  const before = 'Memory is not a feature toggle, and it is not one store. It is an operational boundary.';
  const after = 'Memory needs an operational boundary across its stores.';
  let calls = 0;
  const client = { chat: async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...JSON.parse(reply('Memory controls', 800)), content: `<p>${before}</p>` });
    if (calls === 2) return JSON.stringify({ edits: [edit('content', before, [after])] });
    return verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'long', [], client);
  assert.equal(draft.content.split('\n<hr>')[0], `<p>${after}</p>`);
  assert.equal(calls, 3);
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
    return calls === 1 ? JSON.stringify({ ...JSON.parse(reply('Agent permissions', 350)), content }) : verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(draft.content.split('\n<hr>')[0], content);
  assert.equal(calls, 2, 'Clean copy receives factual review without a rewrite');
});

test('long posts keep the article format with no regeneration', async () => {
  let calls = 0;
  const client = { chat: async () => ++calls === 1 ? reply('Long title', 800) : verified };
  const draft = await generateBlogDraft(source, source.url, 'long', [], client as never);
  assert.equal(calls, 2);
  assert.equal(draft.postType, 'article');
  assert.equal(draft.keyTakeaways.length, 3);
});

test('the logged memory article triplet uses a passing alternative without discarding clean sentences', async () => {
  const before = 'Responsibilities span the agent, the policy layer, the memory service, and source systems.';
  const after = 'The agent shares responsibilities with the policy layer. The memory service and source systems also have defined responsibilities.';
  const content = `<p>Microsoft describes a memory architecture. ${before} Access checks still apply.</p>`;
  let calls = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...JSON.parse(reply('Agent memory boundaries', 800)), content });
    if (calls === 2) return JSON.stringify({ edits: [edit('content', before, [
      before,
      'Responsibilities span the agent, an application policy layer, a platform memory service, and the source systems.',
      after,
    ])] });
    const request = JSON.parse(messages[1]!.content);
    assert.equal(request.draft.content, content.replace(before, after));
    assert.equal(request.previousRejections.length, 2);
    return verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'long', [], client);
  assert.equal(calls, 3);
  assert.equal(draft.content.split('\n<hr>')[0], content.replace(before, after));
  assert.deepEqual(findTropes(draft.content), []);
});

test('factual errors are corrected against source and the revised wording is reviewed again', async () => {
  const before = 'The registry is generally available.';
  const after = 'The registry is in preview.';
  const content = `<p>${before} Administrators can inspect requested permissions.</p>`;
  const evidence = { ...source, body: 'The registry is in preview. Administrators can inspect requested permissions.' };
  let calls = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...JSON.parse(reply('Registry preview', 350)), content });
    const request = JSON.parse(messages[1]!.content);
    assert.equal(request.source.text, evidence.body);
    if (calls === 2) return JSON.stringify({ edits: [edit('content', before, [after], 'accuracy')] });
    assert.equal(request.draft.content, content.replace(before, after));
    return verified;
  } };
  const draft = await generateBlogDraft(evidence, evidence.url, 'short', [], client);
  assert.equal(calls, 3);
  assert.equal(draft.content.split('\n<hr>')[0], content.replace(before, after));
});

test('malformed repairs are retried with feedback and do not replace the draft', async () => {
  const content = '<p>The registry is in preview.</p>';
  let calls = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    calls++;
    if (calls === 1) return JSON.stringify({ ...JSON.parse(reply('Registry preview', 350)), content });
    if (calls === 2) return '{"edits":';
    const request = JSON.parse(messages[1]!.content);
    assert.equal(request.draft.content, content);
    assert.equal(request.previousRejections.length, 1);
    return verified;
  } };
  const draft = await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(calls, 3);
  assert.equal(draft.content.split('\n<hr>')[0], content);
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

test('a clipped editorial response is retried once without regenerating or replacing the saved draft', async () => {
  const calls: Array<{ messages: unknown; tokens: number | undefined }> = [];
  const client = { chat: async (_model: string, messages: Array<{ content: string }>, tokens?: number) => {
    calls.push({ messages, tokens });
    if (calls.length === 1) return reply('Registry preview', 350);
    if (calls.length === 2) throw new AiOutputLimitError();
    assert.deepEqual(messages, calls[1]!.messages);
    assert.equal(tokens, calls[1]!.tokens! * 2);
    return verified;
  } };
  await generateBlogDraft(source, source.url, 'short', [], client);
  assert.equal(calls.length, 3);
  let failures = 0;
  await assert.rejects(generateBlogDraft(source, source.url, 'short', [], { chat: async () => {
    failures++;
    throw new AiOutputLimitError();
  } }), AiOutputLimitError);
  assert.equal(failures, 2);
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
