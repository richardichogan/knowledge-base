import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLUESKY_POST_LIMIT, composeBlueskyText, graphemeLength } from '../src/integrations/social/bluesky.js';
import { blueskyLength } from '../../knowledge-hub-web/src/components/discover/socialLength.js';
import { ValidationError } from '../src/types/errors.js';

const url = 'https://example.com/news/article';

test('composes copy, blank line and link like Copy post + link', () => {
  assert.equal(composeBlueskyText('  Big news today.  ', url), `Big news today.\n\n${url}`);
  assert.equal(composeBlueskyText('No link.', null), 'No link.');
});

test('counts graphemes the way Bluesky does, and the UI agrees', () => {
  assert.equal(graphemeLength('👨‍👩‍👧 é'), 3);
  const copy = 'x'.repeat(BLUESKY_POST_LIMIT - url.length - 2);
  assert.equal(blueskyLength(copy, url), BLUESKY_POST_LIMIT);
  assert.equal(composeBlueskyText(copy, url).length, BLUESKY_POST_LIMIT);
});

test('rejects empty and over-length posts before signing in', () => {
  assert.throws(() => composeBlueskyText('   ', url), ValidationError);
  assert.throws(() => composeBlueskyText('x'.repeat(BLUESKY_POST_LIMIT), url), /Bluesky allows 300/);
});
