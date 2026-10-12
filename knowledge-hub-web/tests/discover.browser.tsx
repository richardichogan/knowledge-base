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
import type { CfpItem } from '../src/services/api';
import { DEFAULT_DISCOVER_VIEW, DISCOVER_PREFERENCES_KEY, SAVED_VIEWS_KEY } from '../src/utils/savedViews';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const failure = <T,>(): ApiResponse<T> => ({ success: false, error: { code: 'FIXTURE', message: 'Fixture read unavailable' } });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const articleId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const emailId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const post = 'Microsoft has announced a new cloud management capability.\n\nFor enterprise IT, this could simplify governance.';
let requests = 0;
let workflowWrites = 0;
let failWorkflow = true;
let fail = false;
let denied = false;
let clipboard = '';
localStorage.removeItem(DISCOVER_PREFERENCES_KEY);
localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify({ version: 1, items: [{
  id: '11111111-1111-4111-8111-111111111111', name: 'Unavailable source scope',
  view: { ...DEFAULT_DISCOVER_VIEW, source: 'Unavailable feed', title: '50%_literal', sort: 'latest' },
}] }));
let requestedSort = '';
let requestedSource: string | undefined;
let requestedTitle: string | undefined;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (value: string) => {
    if (denied) throw new Error('Denied');
    clipboard = value;
  },
} });
const now = new Date().toISOString();
api.getTaxonomy = async () => success([]);
api.getDiscoverSources = async () => success([]);
api.getDiscoverFeed = async (_state, source, _page, _pageSize, title, sort) => {
  requestedSort = sort ?? 'weighted'; requestedSource = source; requestedTitle = title;
  return success({ items: [{
  id: articleId, sourceId: 'test', title: 'A public cloud management announcement', url: 'https://example.com/news',
  description: 'Public news', publishedAt: now, indexedAt: now, sourceTitle: 'Test newsletter', workflowState: 'to-review',
  relevanceScore: 0.8, rankScore: 1.248, relevanceExplanation: 'A useful enterprise IT update.', publishedUrl: null, taxonomyTagIds: [],
  articleType: null, platform: null, sourceType: null, spark: false, sparkReason: null, compositeScore: null,
  rankFactors: { editorial: 0.8, recency: 1, authority: 1.3, articleType: 1.2, project: 1, halfLifeDays: 7, computedAt: now },
}], total: 1, page: 1, pageSize: 25 });
};
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
  <QueryClientProvider client={queryClient}>
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
  throw new Error(`Fixture timed out: ${JSON.stringify({
    sort: requestedSort, source: requestedSource, title: requestedTitle,
    feedbackWrites: requests, workflowWrites, text: document.body.innerText,
  })}`);
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
  check(card.querySelector('.dc-score__value')?.textContent === '124.8rank',
    'Badge shows the actual weighted rank, not relevance or a clamped percentage');
  check(card.querySelector('.dc-score')?.getAttribute('title')?.includes('freshness') === true,
    'Rank tooltip explains the ordering factors');
  const rankFontSize = getComputedStyle(card.querySelector('.dc-score__value')!).fontSize;
  check(parseFloat(rankFontSize) >= 28,
    `Rank number is prominently sized on desktop and mobile (actual ${rankFontSize})`);
  check(parseFloat(getComputedStyle(card.querySelector('.dc-score__value small')!).fontSize) >= 14,
    'Rank label remains readable');
  const metaBounds = card.querySelector('.dc-card-meta')!.getBoundingClientRect();
  const titleBounds = card.querySelector('.dc-card-title')!.getBoundingClientRect();
  const scoreBounds = card.querySelector('.dc-score')!.getBoundingClientRect();
  check(parseFloat(getComputedStyle(card.querySelector('.dc-card-title')!).fontSize) >= 15.75,
    'Article title is slightly larger than the previous 14px');
  if (window.innerWidth > 600) {
    check(titleBounds.top - metaBounds.bottom <= 8, 'Title stays directly below metadata, not below the large rank');
    check(titleBounds.top < scoreBounds.bottom, 'Rank sits beside the heading rather than pushing it down');
    check(titleBounds.right < scoreBounds.left, 'Heading text and rank have separate non-overlapping columns');
  } else {
    check(card.querySelector('.dc-card-title-row')!.getBoundingClientRect().width >= card.clientWidth - 24,
      'Mobile title keeps the full card width instead of being squeezed beside rank');
  }
  checks.push('Weighted ranking badge preserves boosted values and explains ordering');
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
  const setInput = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const rankDetails = card.querySelector<HTMLDetailsElement>('.dc-review__rank')!;
  rankDetails.open = true;
  check(rankDetails.textContent?.includes('124.8 rank points') === true && rankDetails.textContent.includes('x 1.300000'),
    'Accessible breakdown shows exact returned factors and boosted rank');
  const feedbackDetails = card.querySelector<HTMLDetailsElement>('.dc-review__feedback')!;
  feedbackDetails.open = true;
  if (window.innerWidth <= 600) {
    check(feedbackDetails.querySelector('select')!.getBoundingClientRect().height >= 44
      && feedbackDetails.querySelector('select')!.getBoundingClientRect().height <= 46, 'Mobile review controls use compact 44px targets');
  }
  const feedbackText = feedbackDetails.querySelector<HTMLTextAreaElement>('textarea')!;
  setInput(feedbackText, 'Keep this exact explanation after a lost response.');
  await new Promise(resolve => setTimeout(resolve, 30));
  const requestIds: string[] = [];
  let failFeedback = true;
  api.saveDiscoverFeedback = async (id, payload) => {
    check(id === articleId, 'Feedback uses exact source identity');
    requestIds.push(payload.requestId);
    await new Promise(resolve => setTimeout(resolve, 50));
    if (failFeedback) return failure();
    return success({ requestId: payload.requestId });
  };
  const submitFeedback = feedbackDetails.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submitFeedback.click(); submitFeedback.click();
  await waitFor(() => feedbackDetails.querySelector('.kh-data-notice') !== null && !submitFeedback.disabled);
  check(requestIds.length === 1 && feedbackText.value === 'Keep this exact explanation after a lost response.',
    'Feedback failures retain exact input and prevent same-tick duplicates');
  failFeedback = false;
  submitFeedback.click();
  await waitFor(() => feedbackDetails.textContent?.includes('Feedback recorded.') === true);
  check(requestIds.length === 2 && requestIds[0] === requestIds[1] && workflowWrites === 0,
    'Retry reuses durable feedback identity without changing workflow');
  rankDetails.open = false; feedbackDetails.open = false;

  const sortControl = document.querySelector<HTMLSelectElement>('[aria-label="Sort articles"]')!;
  sortControl.value = 'editorial'; sortControl.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => requestedSort === 'editorial');
  const views = document.querySelector<HTMLDetailsElement>('.kh-saved-views')!;
  views.open = true;
  const viewName = views.querySelector<HTMLInputElement>('input')!;
  setInput(viewName, 'Editorial review');
  await new Promise(resolve => setTimeout(resolve, 30));
  click('Save current view');
  await waitFor(() => views.textContent?.includes('View saved on this device.') === true);
  const stored = JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY)!) as { items: Array<{ id: string; name: string; view: { sort: string } }> };
  const editorialView = stored.items.find(item => item.name === 'Editorial review')!;
  check(editorialView.view.sort === 'editorial', 'Named view persists the server sort');
  sortControl.value = 'latest'; sortControl.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => requestedSort === 'latest');
  const picker = views.querySelector<HTMLSelectElement>('select')!;
  picker.value = ''; picker.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  picker.value = editorialView.id; picker.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => requestedSort === 'editorial');
  click('Copy view link');
  await waitFor(() => views.textContent?.includes('View link copied.') === true);
  const shared = new URL(clipboard);
  check((JSON.parse(shared.searchParams.get('view')!) as { sort: string }).sort === 'editorial',
    'Shared link contains the selected sort, not article writing');
  picker.value = '11111111-1111-4111-8111-111111111111'; picker.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => requestedSource === 'Unavailable feed' && requestedTitle === '50%_literal' && requestedSort === 'latest');
  check(document.querySelector<HTMLSelectElement>('[aria-label="Filter by source"]')?.value === 'Unavailable feed',
    'Unavailable saved source remains an explicit scope instead of widening to all feeds');
  await waitFor(() => (JSON.parse(localStorage.getItem(DISCOVER_PREFERENCES_KEY)!) as { source: string }).source === 'Unavailable feed');
  const write = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key: string, value: string): void {
    if (key === SAVED_VIEWS_KEY) throw new Error('Fixture device storage is full');
    write.call(this, key, value);
  };
  try {
    setInput(viewName, 'Retained name after storage failure');
    await new Promise(resolve => setTimeout(resolve, 30));
    click('Save current view');
    await waitFor(() => document.body.textContent?.includes('View could not be loaded or saved') === true);
    check(viewName.value === 'Retained name after storage failure', 'Storage failure preserves the unsaved view name');
  } finally { Storage.prototype.setItem = write; }
  click('Save current view');
  await waitFor(() => document.querySelector('.kh-data-notice') === null);
  picker.value = editorialView.id; picker.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => requestedSource === undefined && requestedTitle === undefined && requestedSort === 'editorial');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'Saved views and review forms fit every viewport');
  views.open = false;
  checks.push('All server sort choices, named device-local views, sharing and retry-safe feedback preserve workflow and exact input');
  const trigger = document.querySelector<HTMLButtonElement>('.dc-action--linkedin')!;
  trigger.focus();
  trigger.click();
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  check(document.querySelector('.kh-dialog__actions button:last-child')?.hasAttribute('disabled') === true, 'Copy disabled while generating');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value === post);
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
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value === post);
  click('Close');
  await waitFor(() => document.querySelector('dialog[open]') === null);
  check(document.activeElement === trigger, 'Focus returns to launching control');
  checks.push('Clipboard denial, generation failure and retry, focus restoration');
  click('Inbox');
  await waitFor(() => document.querySelector('.dc-email-card') !== null);
  click('Socials');
  await waitFor(() => document.querySelector('dialog a')?.getAttribute('href')?.includes('outlook.office.com') === true);
  check(document.querySelector('dialog')!.textContent!.includes('mailbox access'), 'Private mailbox link warning');
  click('Copy post + link');
  await waitFor(() => document.querySelector('dialog')?.textContent?.includes('Nothing has been posted to social media') === true);
  check(workflowWrites === 2, 'Email copies do not use article workflow');
  click('Close');
  await waitFor(() => document.querySelector('dialog[open]') === null);
  checks.push('Inbox email action and exact original mailbox link');
  const inboxRead = api.getTimeline;
  api.getTimeline = async () => failure();
  await queryClient.invalidateQueries({ queryKey: ['discover-emails'] });
  await waitFor(() => document.body.textContent?.includes('Discovery feed is unavailable') === true);
  check(document.querySelector('.dc-empty') === null, 'Failed inbox read cannot claim to be empty');
  api.getTimeline = inboxRead;
  click('Retry');
  await waitFor(() => document.querySelector('.kh-data-notice') === null);
  click('To Review');
  await waitFor(() => document.querySelector('.dc-card') !== null);
  const articleRead = api.getDiscoverFeed;
  api.getDiscoverFeed = async () => failure();
  await queryClient.invalidateQueries({ queryKey: ['discover'] });
  await waitFor(() => document.body.textContent?.includes('Discovery feed is unavailable') === true);
  check(document.querySelector('.dc-empty') === null && document.querySelector('.dc-card') !== null,
    'Failed articles retain cached cards without claiming an empty feed');
  api.getDiscoverFeed = articleRead;
  click('Retry');
  await waitFor(() => document.querySelector('.kh-data-notice') === null);
  const sourceRead = api.getDiscoverSources;
  api.getDiscoverSources = async () => failure();
  await queryClient.invalidateQueries({ queryKey: ['discover-sources'] });
  await waitFor(() => document.body.textContent?.includes('Source filters are unavailable') === true);
  api.getDiscoverSources = sourceRead;
  click('Retry');
  await waitFor(() => document.querySelector('.kh-data-notice') === null);
  api.getCfpItems = async () => failure();
  click('CFPs');
  await waitFor(() => document.body.textContent?.includes('Discovery feed is unavailable') === true);
  check(document.querySelector('.dc-empty') === null, 'Failed CFP read cannot claim no calls for papers');
  api.getCfpItems = async () => success([]);
  click('Retry');
  await waitFor(() => document.querySelector('.kh-data-notice') === null && document.querySelector('.dc-empty') !== null);
  checks.push('False article, inbox, CFP and source envelopes show scoped Retry notices rather than false-empty feeds');
  let cfp: CfpItem = { id: 'cfp-fixture', source: 'callingallpapers', conferenceName: 'Reliable CFP fixture',
    description: null, tags: [], eventUri: null, cfpUri: 'https://example.com/cfp', cfpDeadline: now,
    eventStart: null, eventEnd: null, location: null, isVirtual: true, relevanceScore: null,
    relevanceReason: null, workflowState: 'to_review', discoveredAt: now };
  api.getCfpItems = async (state) => success(state === cfp.workflowState ? [cfp] : []);
  await queryClient.invalidateQueries({ queryKey: ['cfps'] });
  await waitFor(() => document.querySelector('.dc-card--cfp') !== null);
  let cfpWrites = 0;
  let cfpFailure = true;
  api.updateCfpState = async (_id, state) => {
    cfpWrites++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (cfpFailure) return failure();
    cfp = { ...cfp, workflowState: state };
    return success({});
  };
  const saveCfp = document.querySelector<HTMLButtonElement>('.dc-card--cfp .dc-action--save')!;
  saveCfp.click();
  saveCfp.click();
  await waitFor(() => saveCfp.disabled);
  await waitFor(() => document.body.textContent?.includes('Discovery change was not saved') === true && !saveCfp.disabled);
  check(cfpWrites === 1 && document.querySelector('.dc-card--cfp') !== null, 'CFP failed state update retains the card and rejects duplicate requests');
  cfpFailure = false;
  saveCfp.click();
  await waitFor(() => document.querySelector('.dc-card--cfp') === null && document.querySelector('.kh-data-notice') === null);
  api.getDiscoverFeed = async (...args) => {
    const response = await articleRead(...args);
    return response.success ? success({ ...response.data, items: response.data.items.map(item => ({ ...item, workflowState: 'published' as const })) }) : response;
  };
  click('Published');
  await waitFor(() => document.querySelector('.dc-published-url-input') !== null);
  let urlWrites = 0;
  let urlFailure = true;
  api.updateDiscoverPublishedUrl = async () => {
    urlWrites++;
    await new Promise(resolve => setTimeout(resolve, 100));
    return urlFailure ? failure() : success({});
  };
  const urlInput = document.querySelector<HTMLInputElement>('.dc-published-url-input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(urlInput, 'https://example.com/retained-post');
  urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  const saveUrl = document.querySelector<HTMLButtonElement>('.dc-published-url-save')!;
  saveUrl.click();
  saveUrl.click();
  await waitFor(() => urlInput.disabled);
  await waitFor(() => document.querySelector('.dc-published-url-error') !== null && !urlInput.disabled);
  check(urlWrites === 1 && urlInput.value === 'https://example.com/retained-post', 'Failed published URL save preserves input and prevents repeated writes');
  urlFailure = false;
  saveUrl.click();
  await waitFor(() => !urlInput.disabled && document.querySelector('.dc-published-url-error') === null);
  checks.push('Failed CFP and published URL writes retain cards/drafts, lock pending actions and retry once');
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
