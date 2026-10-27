import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOG_CATEGORIES, BLOG_CATEGORY_RULES, BLOG_PACKAGE_RULES } from '../src/ai/blogHouseStyle.js';
import { SHOW_NOTES_PERSONA_BLURB } from '../src/ai/showNotesPersona.js';

process.env['BLOG_POSTS_API_KEY'] = 'isolated-fixture-key';
process.env['BLOG_POSTS_URL'] = 'https://blog.fixture.test/api/v2/posts/';
const { parsePublishBody, sendToBlog } = await import('../src/services/blogPublisher.js');
const { parseBlogDraft, generateBlogDraft, generateIdeasBlogDraft, POST_TYPES } = await import('../src/ai/blogDraft.js');

const fields = {
  title: 'An enterprise view', excerpt: 'Preview.', summary: 'A short summary.', content: '<p>A grounded view.</p>',
  keyTakeaways: [], categories: ['AI', 'Copilot'], tags: ['Dynamics 365'],
};

test('taxonomy matches the blog rejection contract and every blog-writing prompt shares it', () => {
  assert.deepEqual(BLOG_CATEGORIES, [
    'AI', 'Copilot', 'Microsoft Azure', 'Bicep', 'Virtual Machines', 'Cost Management',
    'Security', 'Entra', 'Azure AD', 'Governance', 'GitHub', 'Development', 'PowerShell',
    'Microsoft 365', 'SharePoint Online', 'Architecture', 'Thought Leadership', 'Training',
  ]);
  assert.ok(BLOG_PACKAGE_RULES.includes(BLOG_CATEGORY_RULES));
  assert.ok(SHOW_NOTES_PERSONA_BLURB.includes(BLOG_CATEGORY_RULES));
  assert.ok(SHOW_NOTES_PERSONA_BLURB.includes(`**4. Categories.** ${BLOG_CATEGORY_RULES}`));
});

test('all publishing formats canonicalise and deduplicate accepted categories, keeping topical tags', () => {
  for (const postType of POST_TYPES) {
    const post = parsePublishBody({ ...fields, postType, categories: [' ai ', 'COPILOT', 'Microsoft azure', 'AI'] });
    assert.deepEqual(post.categories, ['AI', 'Copilot', 'Microsoft Azure']);
    assert.deepEqual(post.tags, ['Dynamics 365']);
    assert.equal(post.postType, postType);
  }
});

test('unsupported categories fail before delivery with actionable guidance, including quick takes', () => {
  for (const postType of POST_TYPES) {
    for (const category of ['Dynamics 365', 'Power Platform', 'AI & Copilot', 'Azure', 'Quick Take']) {
      assert.throws(() => parsePublishBody({ ...fields, postType, categories: [category] }), error =>
        error instanceof Error && error.message.includes(category) &&
        error.message.includes('Use any of: AI, Copilot, Microsoft Azure') &&
        error.message.includes('belong in tags'));
    }
  }
});

test('generated drafts enforce canonical categories instead of returning an unpublishable package', () => {
  const parsed = parseBlogDraft(JSON.stringify({ ...fields, categories: [' ai ', 'AI', 'copilot', 'Quick Take'] }), null);
  assert.deepEqual(parsed.categories, ['AI', 'Copilot']);
  assert.throws(() => parseBlogDraft(JSON.stringify({ ...fields, categories: ['Dynamics 365'] }), null),
    /unsupported blog categories: Dynamics 365/);
});

test('publishing accepts introductory clauses with pairs but still rejects actual triplets', () => {
  for (const status of ['draft', 'published'] as const) {
    const content = '<p>In enterprise IT, identity and permissions now travel with the agent.</p>';
    assert.equal(parsePublishBody({ ...fields, status, content }).content, content);
    assert.throws(() => parsePublishBody({
      ...fields, status, content: '<p>Engineering process, policy, and evidence already meet.</p>',
    }), /triplet list/);
  }
});

test('source and ideas drafts use the accepted taxonomy for both quick takes and articles', async () => {
  const prompts: string[] = [];
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    if (messages[0]!.content.includes('final factual editor')) return JSON.stringify({ edits: [] });
    prompts.push(messages[0]!.content);
    return JSON.stringify(fields);
  } };
  for (const length of ['short', 'long'] as const) {
    const source = await generateBlogDraft({ title: 'News', body: 'Source facts.', source: 'discovered-article', url: null }, null, length, [], client);
    const ideas = await generateIdeasBlogDraft('Theme', [{ body: 'An idea.', sourceTitle: null }], length, [], client);
    assert.equal(source.postType, length === 'short' ? 'quick' : 'article');
    assert.equal(ideas.postType, source.postType);
  }
  assert.equal(prompts.length, 4);
  assert.ok(prompts.every(prompt => prompt.includes(BLOG_CATEGORY_RULES)));
});

test('delivery uses the configured endpoint and preserves quick post type independently of categories', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, 'https://blog.fixture.test/api/v2/posts/');
    assert.equal(options?.method, 'POST');
    const post = JSON.parse(String(options?.body));
    assert.equal(post.postType, 'quick');
    assert.deepEqual(post.categories, ['AI', 'Copilot']);
    assert.deepEqual(post.tags, ['Dynamics 365']);
    return new Response(JSON.stringify({ url: 'https://blog.fixture.test/post' }), { status: 201 });
  });
  const result = await sendToBlog(parsePublishBody({ ...fields, postType: 'quick', status: 'draft' }));
  assert.equal(result.payload.success, true);
});

test('the editor category endpoint serves the same taxonomy used by generation and publishing', async t => {
  const { default: express } = await import('express');
  const { discoverRouter } = await import('../src/routes/discover.js');
  const app = express();
  app.use('/api/discover', discoverRouter);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); });
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/discover/blog-categories`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: BLOG_CATEGORIES });
});
