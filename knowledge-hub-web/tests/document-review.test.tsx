import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentViewToggle } from '../src/components/DocumentView';
import { DocumentReview } from '../src/components/DocumentReview';

test('document view switch labels one source with MD and HTML review modes', () => {
  const html = renderToStaticMarkup(<DocumentViewToggle value="html" onChange={() => {}} />);
  assert.match(html, /aria-label="Document view"/);
  assert.match(html, /aria-pressed="true"[^>]*>HTML/);
  assert.match(html, /Visual review of the same source/);
  assert.doesNotMatch(html, /Read-only/);
});

test('visual review explains explicit acceptance and keeps the source content selectable', () => {
  let changes = 0;
  const html = renderToStaticMarkup(<DocumentReview source="Original" version="v1" onApply={() => { changes++; }}>
    <p>Original</p>
  </DocumentReview>);
  assert.match(html, /Nothing changes until you accept/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-label="Select a passage for review"/);
  assert.match(html, /<p>Original<\/p>/);
  assert.equal(changes, 0);
  assert.doesNotMatch(html, /Accept into source/);
});

test('locked documents do not offer a misleading editable review state', () => {
  const html = renderToStaticMarkup(<DocumentReview source="Original" version="v1" disabled onApply={() => {}}>
    <p>Original</p>
  </DocumentReview>);
  assert.match(html, /Editing is unavailable in the current state/);
  assert.doesNotMatch(html, /Propose change|Accept into source/);
});
