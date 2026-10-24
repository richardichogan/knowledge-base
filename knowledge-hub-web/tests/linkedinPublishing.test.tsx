import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import React from 'react';
import ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LinkedInDraftModal } from '../src/components/discover/LinkedInDraftModal';
import type { SocialDraft } from '../src/services/api';

function markup(overrides: Partial<SocialDraft> = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData<SocialDraft>(['discover-linkedin-draft', 'fixture', 'linkedin'], {
    post: 'Reviewed copy', sourceUrl: 'https://example.com/article',
    sourceKind: 'discovered-article', linkedinConfigured: true, linkedinPostUrl: null, linkedinPostStatus: null,
    ...overrides,
  });
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { body: {} }, configurable: true });
  // Render the actual modal content without a DOM or native dialog lifecycle.
  const portal = mock.method(ReactDOM, 'createPortal', children => children);
  const network = mock.method(globalThis, 'fetch', () => { throw new Error('Rendering must not call a provider'); });
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>
      <LinkedInDraftModal itemId="fixture" title="Article" onClose={() => {}} />
    </QueryClientProvider>);
  } finally {
    portal.mock.restore(); network.mock.restore(); client.clear();
    if (document) Object.defineProperty(globalThis, 'document', document);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

function button(html: string, label: string): string {
  const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes(label))?.[0];
  assert.ok(result, `Expected ${label} button`);
  return result;
}

test('configured Discover articles expose reviewed LinkedIn publishing and the full link length', () => {
  const html = markup();
  assert.ok(!button(html, 'Post to LinkedIn').includes('disabled'));
  assert.match(html, /characters including the original link/);
  assert.ok(!html.includes('Posted to LinkedIn.'));
});

test('unconfigured profiles and emails remain copy-only, with setup or privacy guidance', () => {
  const unconfigured = markup({ linkedinConfigured: false });
  assert.ok(!unconfigured.includes('Post to LinkedIn'));
  assert.match(unconfigured, /href="\/my-work"/);
  assert.match(unconfigured, /Connection tokens and API keys/);
  assert.ok(button(unconfigured, 'Copy post + link'));
  const email = markup({ sourceKind: 'email' });
  assert.ok(!email.includes('Post to LinkedIn'));
  assert.match(email, /Review the copy for private information/);
});

test('previously posted, uncertain and oversized posts cannot be sent again from the modal', () => {
  const posted = markup({ linkedinPostStatus: 'posted', linkedinPostUrl: 'https://www.linkedin.com/feed/update/urn:li:share:123/' });
  assert.match(button(posted, 'On LinkedIn'), /disabled/);
  assert.match(posted, /View on LinkedIn/);
  for (const status of ['posting', 'unconfirmed']) {
    const pending = markup({ linkedinPostStatus: status });
    assert.match(button(pending, 'Check LinkedIn'), /disabled/);
    assert.match(pending, /Check your profile; Athena will not send this article again/);
  }
  const oversized = markup({ post: 'x'.repeat(3000) });
  assert.match(button(oversized, 'Post to LinkedIn'), /disabled/);
  assert.match(oversized, /Shorten the post before publishing/);
});
