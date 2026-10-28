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

test('editorial style patterns never prevent article or quick-take delivery', () => {
  for (const status of ['draft', 'published'] as const) {
    const content = '<p>In enterprise IT, identity and permissions now travel with the agent.</p>';
    assert.equal(parsePublishBody({ ...fields, status, content }).content, content);
    const triplet = 'Engineering process, policy, and evidence already meet.';
    const contrast = 'It is not a switch, it is a boundary.';
    const allowed = `<p>${triplet} ${triplet} ${contrast} ${contrast}</p>`;
    assert.equal(parsePublishBody({ ...fields, status, postType: 'article', content: allowed }).content, allowed);
    assert.equal(parsePublishBody({
      ...fields, status, postType: 'article', content: `<p>${triplet} ${triplet} ${triplet}</p>`,
    }).content, `<p>${triplet} ${triplet} ${triplet}</p>`);
    assert.doesNotThrow(() => parsePublishBody({
      ...fields, status, postType: 'article', content: `<p>${contrast} ${contrast} ${contrast}</p>`,
    }));
    const lessLike = 'This looks less like storage, and more like governance.';
    const factualContrast = 'The service uses a queue rather than a database.';
    assert.equal(parsePublishBody({ ...fields, status, postType: 'article',
      content: `<p>${lessLike} ${lessLike} ${factualContrast}</p>` }).content, `<p>${lessLike} ${lessLike} ${factualContrast}</p>`);
    assert.doesNotThrow(() => parsePublishBody({ ...fields, status, postType: 'article',
      content: `<p>${lessLike} ${lessLike} ${lessLike}</p>` }));
    assert.equal(parsePublishBody({ ...fields, status, postType: 'article', excerpt: contrast,
      content: `<p>${contrast} ${contrast}</p>` }).content, `<p>${contrast} ${contrast}</p>`);
    assert.doesNotThrow(() => parsePublishBody({ ...fields, status, postType: 'quick', content: `<p>${triplet}</p>` }));
  }
});

test('publication preserves reviewed punctuation and treats quick-take layout and length as editorial advice', () => {
  const content = `<h2>Context</h2><p>${'word '.repeat(605)}A judgement — with context.</p>`;
  const post = parsePublishBody({ ...fields, postType: 'quick', title: 'A'.repeat(65), content,
    keyTakeaways: ['One.', 'Two.', 'Three.'] });
  assert.equal(post.content, content);
  assert.equal(post.keyTakeaways.length, 3);
});

test('source and ideas drafts use the accepted taxonomy for both quick takes and articles', async () => {
  const prompts: string[] = [];
  const client = { chat: async (_model: string, messages: Array<{ content: string }>, _tokens?: number, _timeout?: number, _signal?: AbortSignal, schema?: { name: string }) => {
    if (schema?.name === 'blog_research_plan') return JSON.stringify({ queries: [] });
    if (schema?.name === 'blog_editorial_review') return JSON.stringify({ findings: [], majorRisks: [] });
    if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
    if (messages[0]!.content.includes('Review factual claims') || messages[0]!.content.includes('Review style, length and coherence')) {
      return JSON.stringify({ findings: [] });
    }
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
