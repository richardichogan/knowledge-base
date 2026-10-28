import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import React from 'react';
import ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlogDraftEditor, BlogPublishModal } from '../src/components/discover/BlogPublishModal';
import { api } from '../src/services/api';

test('Discover and Spark require a format choice without starting a draft on open', () => {
  const client = new QueryClient();
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { body: {} }, configurable: true });
  const portal = mock.method(ReactDOM, 'createPortal', (children: React.ReactNode) => children);
  const handoff = mock.method(api, 'handOffToSpecialist', () => { throw new Error('Opening the dialog must not start a job'); });
  try {
    const sources = [
      <BlogPublishModal itemId="fixture" title="Source" onClose={() => {}} />,
      <BlogPublishModal title="Theme" onClose={() => {}} source={{
        key: 'spark-theme:fixture',
        publish: post => api.publishSparkThemeBlogPost('fixture', post),
      }} />,
    ];
    for (const component of sources) {
      const html = renderToStaticMarkup(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
      assert.match(html, /Quick take/);
      assert.match(html, /Article/);
      assert.match(html, /disabled=""[^>]*>Start drafting/);
      assert.doesNotMatch(html, /Athena is writing/);
    }
    assert.equal(handoff.mock.callCount(), 0);
  } finally {
    handoff.mock.restore(); portal.mock.restore(); client.clear();
    if (document) Object.defineProperty(globalThis, 'document', document);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('the editor keeps blockers visible and collapses secondary fields, advice and review history', () => {
  const client = new QueryClient();
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { body: {} }, configurable: true });
  const portal = mock.method(ReactDOM, 'createPortal', (children: React.ReactNode) => children);
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BlogDraftEditor itemId="fixture" title="Source" jobId="job" onClose={() => {}} initial={{
        url: '?blogJob=job', subjectId: 'discover:fixture',
        draft: { title: 'Title', excerpt: 'Excerpt', summary: 'Summary', content: '<p>Draft.</p>',
          keyTakeaways: [], categories: [], tags: [], postType: 'article', sourceUrl: null },
        verification: { verified: false, issues: ['A claim needs review.'], warnings: ['Repeated wording.'] },
        workflow: { originalAvailable: true, remediationUsed: true, stages: [{
          stage: 'factReview', at: '2026-01-01', result: { findings: [{ reason: 'Unsupported claim', claim: 'A claim' }] },
        }] },
      }} />
    </QueryClientProvider>);
    assert.match(html, /Review history \(1\)/);
    assert.match(html, /Fact review/);
    assert.match(html, /Unsupported claim/);
    assert.match(html, /A claim needs review/);
    assert.match(html, /Advisory suggestions \(1\)/);
    assert.match(html, /Repeated wording/);
    const disclosures = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
    assert.equal(disclosures.length, 3);
    for (const disclosure of disclosures) assert.doesNotMatch(disclosure[1]!, /\bopen\b/);
    assert.match(disclosures[0]![2]!, /<summary>Post details<\/summary>/);
    for (const id of ['blog-excerpt', 'blog-summary', 'blog-takeaways', 'blog-categories', 'blog-tags']) {
      assert.match(disclosures[0]![2]!, new RegExp(`id="${id}"`));
    }
    assert.ok(html.indexOf('id="blog-title"') < html.indexOf('<summary>Post details'));
    assert.ok(html.indexOf('id="blog-content"') < html.indexOf('<summary>Post details'));
    assert.ok(html.indexOf('A claim needs review') < html.indexOf('<details'));
    assert.match(html, /Rich text/);
    assert.match(html, />HTML</);
    for (const action of ['Generate again', 'Recheck draft', 'Save as draft', 'Publish live']) assert.ok(html.includes(action));
  } finally {
    portal.mock.restore(); client.clear();
    if (document) Object.defineProperty(globalThis, 'document', document);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('a passed automated review is not presented as proof of accuracy or voice', () => {
  const client = new QueryClient();
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { body: {} }, configurable: true });
  const portal = mock.method(ReactDOM, 'createPortal', (children: React.ReactNode) => children);
  const draft = { title: 'Title', excerpt: 'Excerpt', summary: 'Summary', content: '<p>Draft.</p>',
    keyTakeaways: [], categories: [], tags: [], postType: 'article' as const, sourceUrl: null };
  const verifiedSignature = JSON.stringify([draft.postType, draft.title, draft.excerpt, draft.summary,
    draft.content, draft.keyTakeaways, draft.categories, draft.tags]);
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BlogDraftEditor itemId="fixture" title="Source" jobId="job" onClose={() => {}} initial={{
        url: '?blogJob=job', subjectId: 'discover:fixture', draft, verifiedSignature,
        verification: { verified: true, issues: [] },
        workflow: { originalAvailable: true, remediationUsed: false, stages: [{
          stage: 'editorialReview', at: '2026-01-01', result: { verified: true, issues: [], majorRisks: [] },
        }] },
      }} />
    </QueryClientProvider>);
    assert.match(html, /Ready to send/);
    assert.match(html, /automated review does not guarantee accuracy/);
    assert.doesNotMatch(html, />Verified\.</);
  } finally {
    portal.mock.restore(); client.clear();
    if (document) Object.defineProperty(globalThis, 'document', document);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
