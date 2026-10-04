import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { combineOutputsForThink, getOutputsForThink } from '../src/ai/thinkOutputExport.js';
import { textToBlocks } from '../src/ai/chatTools.js';
import { Pool } from 'pg';

test('exports the full package in podcast order without truncation', () => {
  const blog = '# Editorial title\n\n' + 'Full content. '.repeat(3_000);
  const youtube = 'YouTube title\n\n00:01 Intro\n01:23 Discussion\n**literal text**';
  const spotify = 'Spotify title\n<p>Description</p>\n\n<h3>Links</h3>';
  const exported = combineOutputsForThink([
    { title: 'Bluesky daily posts', format: 'markdown', content: 'Daily posts and quotes' },
    { title: 'Companion blog post', format: 'markdown', content: blog },
    { title: 'Spotify show notes', format: 'text', content: spotify },
    { title: 'YouTube show notes', format: 'text', content: youtube },
    { title: 'Titles and metadata', format: 'markdown', content: 'Metadata' },
    { title: 'Social campaign', format: 'markdown', content: 'Campaign' },
    { title: 'Blog show notes', format: 'markdown', content: 'Blog notes' },
  ], 'Podcast package', 'podcast_show_notes');
  assert.equal(exported.title, 'Podcast package');
  assert.ok(exported.bodyMarkdown.includes(blog));
  assert.ok(exported.bodyMarkdown.indexOf('## Titles and metadata') < exported.bodyMarkdown.indexOf('## YouTube show notes'));
  assert.ok(exported.bodyMarkdown.indexOf('## Social campaign') < exported.bodyMarkdown.indexOf('## Bluesky daily posts'));
  const blocks = textToBlocks(exported.bodyMarkdown);
  const code = blocks.filter((block) => block.type === 'codeBlock');
  assert.equal(code.length, 2);
  assert.equal(code[0]?.content[0]?.text, youtube);
  assert.equal(code[1]?.content[0]?.text, spotify);
  assert.equal(code[1]?.props?.language, 'html');
  assert.ok(blocks.some((block) => block.content.some((part) => part.text === 'Full content. '.repeat(3_000).trim())));
});

test('embedded fences and markdown examples remain intact', () => {
  const content = 'Example:\n```html\n<p>Example</p>\n```\n';
  const exported = combineOutputsForThink([
    { title: 'Raw example', format: 'text', content },
  ], 'Example', 'general');
  const blocks = textToBlocks(exported.bodyMarkdown);
  assert.equal(blocks[1]?.type, 'codeBlock');
  assert.equal(blocks[1]?.content[0]?.text, content);
  assert.equal(textToBlocks('## Heading\n\n**Bold**')[0]?.type, 'heading');
});

test('reads only the latest output versions in a single session-scoped query', async () => {
  const db = new Pool();
  mock.method(db, 'query', async (sql: string, parameters: string[]) => {
      assert.match(sql, /ORDER BY version DESC LIMIT 1/);
      assert.match(sql, /WHERE o.session_id = \$1/);
      assert.deepEqual(parameters, ['session-id']);
      return { rows: [{ title: 'Saved output', format: 'markdown', content: 'Latest revision', session_title: 'My chat' }] };
  });
  const exported = await getOutputsForThink(db, 'session-id', 'general');
  assert.equal(exported?.title, 'My chat');
  assert.equal(exported?.bodyMarkdown, '## Saved output\n\nLatest revision');
});

test('no Outputs uses the existing conversation export; empty saved Outputs fail explicitly', async () => {
  const emptyDb = new Pool();
  mock.method(emptyDb, 'query', async () => ({ rows: [] }));
  assert.equal(await getOutputsForThink(emptyDb, 'empty', 'general'), null);
  const brokenDb = new Pool();
  mock.method(brokenDb, 'query', async () => ({ rows: [{ content: null }] }));
  await assert.rejects(getOutputsForThink(brokenDb, 'broken', 'general'), /saved Output has no content/);
});
