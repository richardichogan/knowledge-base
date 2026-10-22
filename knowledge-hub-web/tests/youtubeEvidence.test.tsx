import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { YouTubeEvidenceNotice } from '../src/components/discover/YouTubeEvidenceNotice';

test('YouTube related sources are visible clickable background links, never presented as a transcript', () => {
  const html = renderToStaticMarkup(<YouTubeEvidenceNotice item={{
    contentBasis: 'description-only',
    relatedArticles: [{ title: 'Project Perception | Microsoft Security', url: 'https://www.microsoft.com/security/perception' }],
  }} />);
  assert.match(html, /Related background reading/);
  assert.match(html, /href="https:\/\/www.microsoft.com\/security\/perception"/);
  assert.match(html, /target="_blank" rel="noreferrer"/);
  assert.match(html, /not a transcript/);
  assert.ok(!html.includes('public captions retrieved'));
});

test('Caption evidence is qualified, and missing related sources do not create empty sections', () => {
  const html = renderToStaticMarkup(<YouTubeEvidenceNotice item={{ contentBasis: 'captions' }} />);
  assert.match(html, /public captions retrieved/);
  assert.match(html, /automatically generated/);
  assert.ok(!html.includes('Related background reading'));
  assert.equal(renderToStaticMarkup(<YouTubeEvidenceNotice item={{}} />), '');
});
