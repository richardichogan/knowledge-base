import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINKEDIN_POST_LIMIT, linkedinLength, blueskyLength, socialLength } from '../src/components/discover/socialLength';

test('LinkedIn counts the reviewed text, blank line and full source URL at the publishing boundary', () => {
  const url = 'https://example.com/article';
  const copy = 'x'.repeat(LINKEDIN_POST_LIMIT - url.length - 2);
  assert.equal(linkedinLength(copy, url), LINKEDIN_POST_LIMIT);
  assert.equal(linkedinLength(`${copy}x`, url), LINKEDIN_POST_LIMIT + 1);
  assert.equal(linkedinLength('  Hello  ', null), 5);
  assert.equal(linkedinLength('Hello', url), `Hello\n\n${url}`.length);
});

test('LinkedIn uses a conservative UTF-16 limit independently of Bluesky graphemes and X link weighting', () => {
  assert.equal(linkedinLength('😀', null), 2);
  assert.equal(blueskyLength('😀', null), 1);
  assert.equal(socialLength('Hello', 'https://a.co'), 5 + 2 + 23);
});
