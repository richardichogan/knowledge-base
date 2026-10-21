import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlogPostEditor } from '../src/components/discover/BlogPostEditor';

test('post editor defaults to an editable rich text field with an HTML source toggle', () => {
  let changes = 0;
  const html = renderToStaticMarkup(<BlogPostEditor value="<p>A <strong>draft</strong></p>"
    onChange={() => { changes++; }} />);
  assert.match(html, /aria-pressed="true">Rich text/);
  assert.match(html, /aria-pressed="false">HTML/);
  assert.match(html, /role="textbox"/);
  assert.match(html, /contenteditable="true"/);
  assert.match(html, /aria-multiline="true"/);
  for (const label of ['Bold', 'Italic', 'Heading', 'Bullet list', 'Numbered list', 'Undo', 'Redo']) {
    assert.ok(html.includes(`>${label}</button>`));
  }
  assert.match(html, /always sent as HTML/);
  assert.equal(changes, 0, 'Rendering must not rewrite the HTML source');
});

test('post editor cannot be changed while a post is being sent', () => {
  const html = renderToStaticMarkup(<BlogPostEditor value="<p>Draft</p>" disabled onChange={() => {}} />);
  assert.match(html, /contenteditable="false"/);
  assert.match(html, /aria-readonly="true"/);
  assert.ok([...html.matchAll(/<button[^>]*>/g)].every(([button]) => button.includes('disabled')));
});
