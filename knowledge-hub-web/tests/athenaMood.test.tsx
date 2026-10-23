import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ATHENA_MOODS, resolveAthenaMood, type AthenaEmotion } from '../src/chat/athenaMood';
import { AthenaRibbon } from '../src/components/athena/AthenaRibbon';

test('nine moods use the supplied element with explicit size, tracking and static-history attributes', () => {
  assert.equal(ATHENA_MOODS.length, 9);
  for (const mood of ATHENA_MOODS) {
    const html = renderToStaticMarkup(<AthenaRibbon mood={mood} size={240} track />);
    assert.match(html, new RegExp(`mood="${mood}"`));
    assert.match(html, /<athena-ribbon.*size="240"/);
    assert.match(html, /track=""/);
    assert.match(html, /silent=""/);
    assert.doesNotMatch(html, /tabindex|<button/);
  }
  assert.match(renderToStaticMarkup(<AthenaRibbon still />), /size="32".*still=""/);
  assert.doesNotMatch(renderToStaticMarkup(<AthenaRibbon size={44} silent={false} />), /silent=/);
});

test('lifecycle prioritises active work over old emotion and never interprets draft text', () => {
  const emotion = { mood: 'happy' as const, context: 'a', startsAt: 100, endsAt: 2600 };
  assert.equal(resolveAthenaMood('typing', emotion, 'a', 1000), 'listening');
  assert.equal(resolveAthenaMood('listening', emotion, 'a', 1000), 'listening');
  assert.equal(resolveAthenaMood('thinking', emotion, 'a', 1000), 'thinking');
  assert.equal(resolveAthenaMood('writing', emotion, 'a', 1000), 'answering');
});

test('emotions expire, defer until accepted-answer reveal, and cannot leak into another chat', () => {
  for (const mood of ['happy', 'curious', 'unsure', 'sorry', 'excited'] satisfies AthenaEmotion[]) {
    const event = { mood, context: 'a', startsAt: 1500, endsAt: 4000 };
    assert.equal(resolveAthenaMood('idle', event, 'a', 1499), 'resting');
    assert.equal(resolveAthenaMood('idle', event, 'a', 1500), mood);
    assert.equal(resolveAthenaMood('idle', event, 'a', 3999), mood);
    assert.equal(resolveAthenaMood('idle', event, 'a', 4000), 'resting');
    assert.equal(resolveAthenaMood('idle', event, 'b', 2000), 'resting');
  }
});
