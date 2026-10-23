import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsedLine } from '../src/components/athena/UsedLine';
import type { ContextUsedApi } from '../src/types';

const empty: ContextUsedApi = { project: null, instructions: 0, inView: null, found: [], auto: [], outputs: 0, decisions: 0, screens: 0 };
const render = (used: ContextUsedApi): string => renderToStaticMarkup(
  <UsedLine used={used} excluded={new Set()} onExclude={() => { throw new Error('Rendering must not exclude sources'); }}
    onInclude={() => { throw new Error('Rendering must not include sources'); }} />,
);

test('reply references use a compact disclosure instead of repeating long context titles', () => {
  const html = render({ ...empty, project: 'IBM Thought Leadership', instructions: 8, inView: 'Reaching for the Cloud: Edition 42', decisions: 2 });
  assert.match(html, /Context &amp; references/);
  assert.match(html, /8 instructions/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.doesNotMatch(html, /IBM Thought Leadership|Reaching for the Cloud|Used:/);
});

test('reference counts deduplicate sources and keep notices visible when collapsed', () => {
  const source = { id: 'fixture', kind: 'note', title: 'A source', lifecycle: 'cited' as const };
  const html = render({ ...empty, found: [source], auto: [source], warnings: [{ message: 'One provider was unavailable' }] });
  assert.match(html, /1 source</);
  assert.match(html, /ai-used__notices">1 notice</);
});

test('context-only replies remain expandable and genuinely empty references stay hidden', () => {
  assert.match(render({ ...empty, inView: 'A note' }), /Context &amp; references/);
  assert.match(render({ ...empty, decisions: 1 }), /Context &amp; references/);
  assert.equal(render(empty), '');
});
