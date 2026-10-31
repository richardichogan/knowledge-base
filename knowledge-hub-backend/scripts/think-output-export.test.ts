import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { combineOutputsForThink, getOutputsForThink } from '../src/ai/thinkOutputExport.js';
import { textToBlocks } from '../src/ai/chatTools.js';
import { Pool } from 'pg';
import { spotifyShowNotesSource, validateShowNotesReferences } from '../src/ai/spotifyShowNotes.js';

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
  assert.equal(code.length, 1);
  assert.equal(code[0]?.content[0]?.type === 'text' ? code[0].content[0].text : undefined, spotify);
  assert.equal(code[0]?.props?.language, 'html');
  const youtubeStart = blocks.findIndex(block => block.type === 'heading' && block.content.some(part => part.type === 'text' && part.text === 'YouTube show notes'));
  const spotifyStart = blocks.findIndex(block => block.type === 'heading' && block.content.some(part => part.type === 'text' && part.text === 'Spotify show notes'));
  const youtubeBlocks = blocks.slice(youtubeStart + 1, spotifyStart);
  assert.ok(youtubeBlocks.every(block => block.type === 'paragraph'));
  assert.equal(youtubeBlocks.map(block => block.type === 'paragraph'
    ? block.content.map(part => part.type === 'text' ? part.text : '').join('') : '').join('\n\n'), youtube);
  assert.ok(blocks.some((block) => block.type === 'paragraph' && block.content.some((part) => part.type === 'text' && part.text.trim() === 'Full content. '.repeat(3_000).trim())));
});

test('embedded fences and markdown examples remain intact', () => {
  const content = 'Example:\n```html\n<p>Example</p>\n```\n';
  const exported = combineOutputsForThink([
    { title: 'Raw example', format: 'text', content },
  ], 'Example', 'general');
  const blocks = textToBlocks(exported.bodyMarkdown);
  assert.equal(blocks[1]?.type, 'codeBlock');
  const code = blocks[1];
  assert.equal(code?.type === 'codeBlock' && code.content[0]?.type === 'text' ? code.content[0].text : undefined, content);
  assert.equal(textToBlocks('## Heading\n\n**Bold**')[0]?.type, 'heading');
});

test('Spotify saved as Markdown exports as literal HTML in a native code block', () => {
  const exported = combineOutputsForThink([{
    title: 'Spotify show notes', format: 'markdown',
    content: 'Cloud governance\n\nA practical discussion.\n\n### Links\n\n- [Official reference](https://learn.microsoft.com/azure/)',
  }], 'Episode', 'podcast_show_notes');
  const blocks = textToBlocks(exported.bodyMarkdown);
  const code = blocks.find(block => block.type === 'codeBlock');
  assert.equal(code?.type, 'codeBlock');
  if (code?.type !== 'codeBlock') assert.fail('Spotify HTML code block is missing');
  assert.equal(code.props?.language, 'html');
  const html = code.content.map(part => part.type === 'text' ? part.text : '').join('');
  assert.match(html, /^Cloud governance\n<p>A practical discussion\.<\/p>/);
  assert.match(html, /<h3>Links<\/h3><ul><li><a href="https:\/\/learn.microsoft.com\/azure\/">Official reference<\/a><\/li><\/ul>/);
});

test('Spotify conversion keeps existing HTML, unwraps fences and rejects unsupported markup and size', () => {
  const source = 'Cloud governance\n<p>Discussion.</p><h3>Links</h3><ul><li><a href="https://example.com/">Reference</a></li></ul>';
  assert.equal(spotifyShowNotesSource(source), source);
  assert.equal(spotifyShowNotesSource('```html\n' + source + '\n```'), source);
  assert.equal(spotifyShowNotesSource('Cloud governance\n```html\n<p>Discussion.</p>\n```'), 'Cloud governance\n<p>Discussion.</p>');
  assert.throws(() => spotifyShowNotesSource('Title\n<p onclick="alert(1)">Unsafe</p>'), /only p/);
  assert.throws(() => spotifyShowNotesSource('Title\n<p>Unsafe</p><script>alert(1)</script>'), /only p/);
  assert.throws(() => spotifyShowNotesSource('Title\n<p><a href="javascript:alert(1)">Unsafe</a></p>'), /HTTP/);
  assert.throws(() => spotifyShowNotesSource('Title\n<p>HTML description.</p>\n### Markdown footer'), /outside its HTML/);
  assert.throws(() => spotifyShowNotesSource('Title\n<p>' + 'x'.repeat(3993) + '</p>'), /4,000/);
  assert.throws(() => spotifyShowNotesSource('x'.repeat(60) + '\n<p>Body</p>'), /under 60/);
});

test('show notes require matching platform references or a saved explanation of unavailable references', () => {
  const spotify = 'Episode title\n<p>Discussion.</p><h3>Links</h3><ul><li><a href="https://example.com/article">Source</a></li></ul>'
    + '<h3>Socials</h3><ul><li><a href="https://example.com/social">Social</a></li></ul>';
  const youtube = 'YouTube title\nDescription.\n\nLinks:\nSource: https://example.com/article\n\nSocials:\nhttps://example.com/social';
  assert.doesNotThrow(() => validateShowNotesReferences(spotify, youtube, 'Metadata'));
  assert.throws(() => validateShowNotesReferences(spotify, youtube.replace('/article', '/wrong'), 'Metadata'), /do not match/);
  assert.throws(() => validateShowNotesReferences(spotify, youtube.replace('/article', '/wrong'), 'Metadata'), {
    message: /Missing from Spotify: https:\/\/example.com\/wrong\. Missing from YouTube: https:\/\/example.com\/article\./,
  });
  assert.throws(() => validateShowNotesReferences('Title\n<p>No references.</p>', 'No references.', 'Metadata'), /missing/);
  assert.doesNotThrow(() => validateShowNotesReferences('Title\n<p>No references.</p>', 'No references.',
    'Reference limitations: The official page could not be opened for verification.'));
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
