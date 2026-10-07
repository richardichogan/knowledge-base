import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiscoverPage } from '../src/pages/DiscoverPage';
import { AppDialogHost } from '../src/components/AppDialog';
import { AthenaContextProvider } from '../src/context/AthenaContext';
import { api } from '../src/services/api';
import { alertDialog, confirmDialog } from '../src/services/appDialogs';
import type { ApiResponse } from '../src/types/apiResponse';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const articleId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const emailId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const post = 'Microsoft has announced a new cloud management capability.\n\nFor enterprise IT, this could simplify governance.';
let requests = 0;
let workflowWrites = 0;
let failWorkflow = true;
let fail = false;
let denied = false;
let clipboard = '';
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (value: string) => {
    if (denied) throw new Error('Denied');
    clipboard = value;
  },
} });
const now = new Date().toISOString();
api.getTaxonomy = async () => success([]);
api.getDiscoverSources = async () => success([]);
api.getDiscoverFeed = async () => success({ items: [{
  id: articleId, sourceId: 'test', title: 'A public cloud management announcement', url: 'https://example.com/news',
  description: 'Public news', publishedAt: now, indexedAt: now, sourceTitle: 'Test newsletter', workflowState: 'to-review',
  relevanceScore: null, relevanceExplanation: 'A useful enterprise IT update.', publishedUrl: null, taxonomyTagIds: [],
  articleType: null, platform: null, sourceType: null, spark: false, sparkReason: null, compositeScore: null,
}], total: 1, page: 1, pageSize: 25 });
api.getTimeline = async () => success({ items: [{
  id: emailId, sourceId: 'email', source: 'email', title: 'Cloud news by email', summary: 'A public product newsletter.',
  publishedAt: now, metadata: { from: 'Newsletter', accountLabel: 'Personal' },
}], total: 1, page: 1, pageSize: 50, hasMore: false });
api.createLinkedInDraft = async (id) => {
  requests++;
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (fail) throw new Error('Generation failed. Please try again.');
  return success({ post, sourceUrl: id === emailId ? 'https://outlook.office.com/mail/id/example' : 'https://example.com/news',
    sourceKind: id === emailId ? 'email' : 'discovered-article' });
};
api.updateDiscoverWorkflow = async (id, state) => {
  check(id === articleId && state === 'published', 'Article copies match Copy URL workflow');
  workflowWrites++;
  if (failWorkflow) throw new Error('Workflow unavailable');
  return success({});
};

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><AthenaContextProvider>
      <AppDialogHost /><div className="kh-content" style={{ height: '100%' }}><DiscoverPage /></div>
    </AthenaContextProvider></MemoryRouter>
  </QueryClientProvider>,
);

function check(condition: boolean, message: string): void { if (!condition) throw new Error(message); }
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Fixture timed out');
}
function click(text: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  button.click();
}

export async function runDiscoverChecks(): Promise<string[]> {
  const checks: string[] = [];
  await waitFor(() => document.querySelector('.dc-action--linkedin') !== null);
  const card = document.querySelector<HTMLElement>('.dc-card')!;
  const more = card.querySelector<HTMLElement>('.dc-card-actions__more')!;
  check(!card.matches(':hover') && !card.matches(':focus-within'), 'Check actions before hovering or focusing the card');
  check(getComputedStyle(more).opacity === '1', 'Secondary Discover actions remain visible without hover');
  for (const button of more.querySelectorAll<HTMLButtonElement>('button')) {
    const style = getComputedStyle(button);
    check(style.visibility === 'visible' && style.display !== 'none' && button.getBoundingClientRect().width > 0,
      'Copy URL, Canvas, Spark and Connections controls are discoverable');
  }
  check(document.documentElement.scrollWidth <= window.innerWidth, 'Visible actions do not cause horizontal page overflow');
  checks.push('All article actions visible before hover/focus on desktop and touch layouts');
  const trigger = document.querySelector<HTMLButtonElement>('.dc-action--linkedin')!;
  trigger.focus();
  trigger.click();
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  check(document.querySelector('.kh-dialog__actions button:last-child')?.hasAttribute('disabled') === true, 'Copy disabled while generating');
  await waitFor(() => document.querySelector('textarea')?.value === post);
  check(document.querySelector('dialog a')?.getAttribute('href') === 'https://example.com/news', 'Original article link');
  check(workflowWrites === 0, 'Generating does not move the article');
  click('Copy post + link');
  await waitFor(() => document.querySelector('.dc-linkedin__error')?.textContent?.includes('could not be moved') === true);
  failWorkflow = false;
  click('Copied');
  await waitFor(() => document.querySelector('dialog')?.textContent?.includes('Article moved to Published') === true);
  check(clipboard === `${post}\n\nhttps://example.com/news`, 'Clipboard paragraph breaks and source URL');
  check(workflowWrites === 2, 'Copy moves article to Published with explicit failure and retry');
  checks.push('Article draft, clipboard paragraphs, Published workflow, explicit workflow failure and retry');
  denied = true;
  click('Copied');
  await waitFor(() => document.querySelector('.dc-linkedin__error') !== null);
  check(document.querySelector('.dc-linkedin__error')!.textContent!.includes('copy it manually'), 'Clipboard denial recovery');
  check(workflowWrites === 2, 'Clipboard denial never changes workflow');
  denied = false;
  fail = true;
  click('Generate again');
  await waitFor(() => document.querySelector('.dc-linkedin__error')?.textContent?.includes('Generation failed') === true);
  check(document.querySelector<HTMLButtonElement>('.kh-dialog__actions button:last-child')!.disabled, 'No copying stale draft after failure');
  fail = false;
  click('Generate again');
  await waitFor(() => document.querySelector('textarea')?.value === post);
  click('Close');
  await waitFor(() => document.querySelector('dialog[open]') === null);
  check(document.activeElement === trigger, 'Focus returns to launching control');
  checks.push('Clipboard denial, generation failure and retry, focus restoration');
  click('Inbox');
  await waitFor(() => document.querySelector('.dc-email-card') !== null);
  click('LinkedIn post');
  await waitFor(() => document.querySelector('dialog a')?.getAttribute('href')?.includes('outlook.office.com') === true);
  check(document.querySelector('dialog')!.textContent!.includes('mailbox access'), 'Private mailbox link warning');
  click('Copy post + link');
  await waitFor(() => document.querySelector('dialog')?.textContent?.includes('Nothing has been posted to LinkedIn') === true);
  check(workflowWrites === 2, 'Email copies do not use article workflow');
  click('Close');
  await waitFor(() => document.querySelector('dialog[open]') === null);
  checks.push('Inbox email action and exact original mailbox link');
  const confirmation = confirmDialog('Delete this test item? This cannot be undone.', { title: 'Delete item', confirmLabel: 'Delete', tone: 'danger' });
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  check(document.activeElement?.textContent === 'Cancel', 'Destructive confirmation defaults to Cancel');
  click('Cancel');
  check(await confirmation === false, 'Cancel does not confirm');
  await waitFor(() => document.querySelector('dialog[open]') === null);
  void alertDialog('Your draft is ready.\n\nParagraph breaks are preserved.', { title: 'Ready to share', tone: 'success' });
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  const dialog = document.querySelector('dialog')!;
  check(dialog.getBoundingClientRect().width <= window.innerWidth - 30, 'Responsive dialog width');
  check(getComputedStyle(document.querySelector('.kh-dialog__message')!).whiteSpace === 'pre-wrap', 'Alert line breaks');
  checks.push('Styled alerts, destructive cancel, safe focus and responsive layout');
  check(requests === 4, 'No hidden generation calls');
  return checks;
}

Object.assign(window, { runDiscoverChecks });
