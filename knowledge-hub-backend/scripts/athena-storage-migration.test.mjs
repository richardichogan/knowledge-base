import assert from 'node:assert/strict';
import test from 'node:test';
import { ATHENA_CONTAINERS, athenaUrlPattern, blobIdentity, replaceAthenaUrls } from './migrate-athena-storage.mjs';

test('migration is limited to the three dedicated Athena containers', () => {
  assert.deepEqual(ATHENA_CONTAINERS, ['kb-documents', 'kb-images', 'chat-screens']);
  const blog = 'https://mscloudblogs2026.blob.core.windows.net/blogcontent/posts/post-1.json';
  const image = 'https://mscloudblogs2026.blob.core.windows.net/images/blog.png';
  const other = 'https://otheraccount.blob.core.windows.net/kb-documents/file.pdf';
  const original = [blog, image, other].join(' ');
  assert.equal(replaceAthenaUrls(original, () => { throw new Error('Must not touch blog or other accounts'); }), original);
  assert.throws(() => blobIdentity(blog), /Not an Athena blob/);
});

test('rewrites nested note JSON and Markdown without damaging surrounding syntax', () => {
  const old = 'https://mscloudblogs2026.blob.core.windows.net/kb-images/123?se=2036-01-01&sig=abc%3D';
  const replacement = 'https://khprodr6mgdnys.blob.core.windows.net/kb-images/123?sig=new';
  const note = JSON.stringify({ contentJson: JSON.stringify([{ type: 'image', props: { url: old } }]) });
  assert.equal(JSON.parse(JSON.parse(replaceAthenaUrls(note, () => replacement)).contentJson)[0].props.url, replacement);
  assert.equal(replaceAthenaUrls(`![image](${old})`, () => replacement), `![image](${replacement})`);
  assert.equal([...old.matchAll(athenaUrlPattern())].length, 1);
});

test('blob paths are decoded and query tokens never become blob names', () => {
  assert.deepEqual(blobIdentity('https://mscloudblogs2026.blob.core.windows.net/kb-documents/a%20b.pdf?sig=secret'),
    { container: 'kb-documents', name: 'a b.pdf' });
  assert.throws(() => athenaUrlPattern('invalid.account'), /Invalid account/);
});
