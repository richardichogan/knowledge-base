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
import { DISCOVER_PREFERENCES_KEY } from '../src/utils/savedViews';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const failure = <T,>(): ApiResponse<T> => ({ success: false, error: { code: 'FIXTURE', message: 'Fixture read unavailable' } });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const articleId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const emailId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const post = 'Microsoft has announced a new cloud management capability.\n\nFor enterprise IT, this could simplify governance.';
let requests = 0;
let feedReads = 0;
let workflowWrites = 0;
let failWorkflow = true;
let fail = false;
let denied = false;
let clipboard = '';
localStorage.removeItem(DISCOVER_PREFERENCES_KEY);
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (value: string) => {
    if (denied) throw new Error('Denied');
    clipboard = value;
  },
} });
const now = new Date().toISOString();
api.getTaxonomy = async () => success([]);
api.getDiscoverSources = async () => success([]);
api.listDiscoveryFeeds = async () => success([]);
let addedChannel = '';
let addedVideo = '';
api.addDiscoveryFeed = async data => {
  addedChannel = data.feedUrl;
  return success({ id: 'youtube-channel', title: data.title, feedUrl: data.feedUrl, groupName: data.groupName,
    isActive: true, lastCheckedAt: null, lastSuccessAt: null, lastError: null, lastNewCount: 0, articlesFound: 0, itemsInFeed: 15 });
};
api.addDiscoveryVideo = async url => {
  addedVideo = url;
  return success({ id: 'youtube-video', title: 'Agentic borders', isNew: true });
};
api.getDiscoverFeed = async () => {
  feedReads++;
  return success({ items: [{
  id: articleId, sourceId: 'test', title: 'A public cloud management announcement', url: 'https://example.com/news',
  description: 'Public news', publishedAt: now, indexedAt: now, sourceTitle: 'Test newsletter', workflowState: 'to-review',
  relevanceScore: 0.8, rankScore: 1.248, relevanceExplanation: 'A useful enterprise IT update.', publishedUrl: null, taxonomyTagIds: [],
  articleType: null, platform: null, sourceType: null, spark: false, sparkReason: null, compositeScore: null,
  rankFactors: { editorial: 0.8, recency: 1, authority: 1.3, articleType: 1.2, project: 1, halfLifeDays: 7, computedAt: now },
  parking: { newsletter: true, podcast: true, parkedAt: now, updatedAt: now },
}], total: 1, page: 1, pageSize: 25 });
};
api.getTimeline = async () => success({ items: [{
  id: emailId, sourceId: 'email', source: 'email', title: '[blog] Cloud news by email', summary: 'From: Contoso News <news@contoso.com> on 2026-10-16',
  publishedAt: now, url: 'https://outlook.office.com/mail/id/example',
  metadata: { from: 'Contoso News <news@contoso.com>', account: 'richard.hogan@themicrosoftcloudblog.com', accountLabel: 'blog', isRead: false },
}, {
  id: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee', sourceId: 'email-2', source: 'email', title: '[podcast] Guest confirmation', summary: 'From: guest@example.com on 2026-10-15',
  publishedAt: now, metadata: { from: 'guest@example.com', account: 'podcast@themicrosoftcloudblog.com', accountLabel: 'podcast', isRead: true },
}], total: 2, page: 1, pageSize: 50, hasMore: false });
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
    feedbackWrites: requests, workflowWrites, text: document.body.innerText,
  })}`);
}
function click(text: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  button.click();
}

function el<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Missing element ${selector}: ${document.body.innerText.slice(0, 600)}`);
  return found;
}

function openList(key: string): void {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Other Discover lists"]')!;
  select.value = key;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function runDiscoverChecks(): Promise<string[]> {
  const checks: string[] = [];
  await waitFor(() => document.querySelector('.dc-card .dc-action--explore') !== null);
  check(feedReads === 1, 'For you and its briefing share one ranked-feed request on entry');
  check(document.querySelector('.dc-card-parked')?.textContent?.includes('Parked: Newsletter + Podcast') === true,
    'For you marks parked articles and names their destinations');
  click('Sources');
  await waitFor(() => document.querySelector('.dc-sources') !== null);
  const setInput = (label: string, value: string): void => {
    const input = el<HTMLInputElement>(`input[aria-label="${label}"]`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setInput('Source name', 'Microsoft Azure');
  setInput('Feed address or YouTube channel URL', 'https://www.youtube.com/@MicrosoftAzure');
  await waitFor(() => ![...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Add source')!.disabled);
  click('Add source');
  await waitFor(() => document.querySelector('.dc-sources__msg[role="status"]')?.textContent?.includes('15 items') === true);
  check(addedChannel === 'https://www.youtube.com/@MicrosoftAzure', 'Sources accepts a normal channel URL');
  setInput('YouTube video URL', 'https://youtu.be/O9nqK23LRbA');
  await waitFor(() => ![...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Add video')!.disabled);
  click('Add video');
  await waitFor(() => document.querySelector('.dc-sources__msg[role="status"]')?.textContent?.includes('no transcript retrieved') === true);
  check(addedVideo === 'https://youtu.be/O9nqK23LRbA', 'Individual video import uses the supplied URL');
  el<HTMLButtonElement>('[aria-label="Close sources"]').click();
  await waitFor(() => document.querySelector('.dc-sources') === null);
  checks.push('Normal channel URL and individual YouTube video import with explicit description-only status');
  const card = document.querySelector<HTMLElement>('.dc-card')!;
  check(card.querySelector('.dc-card-title')?.textContent === 'A public cloud management announcement', 'Card shows the article title');
  check(card.querySelector('.dc-card-synopsis')?.textContent === 'A useful enterprise IT update.', 'Card shows Athena\'s synopsis');
  check(!card.textContent!.includes('Why Athena picked this'), 'Selection reasons live in Explore, not on the card');
  check(!card.matches(':hover') && !card.matches(':focus-within'), 'Check actions before hovering or focusing the card');
  for (const action of card.querySelectorAll<HTMLButtonElement>('.dc-card-actions button')) {
    const style = getComputedStyle(action);
    check(style.visibility === 'visible' && style.display !== 'none' && action.getBoundingClientRect().width > 0,
      'Save, Not interested and Explore are visible without hover');
  }
  const title = card.querySelector<HTMLElement>('.dc-card-title')!;
  const synopsis = card.querySelector<HTMLElement>('.dc-card-synopsis')!;
  check(parseFloat(getComputedStyle(title).fontSize) >= 15.75 && parseFloat(getComputedStyle(synopsis).fontSize) >= 14,
    'Discover titles and synopses use readable sizes');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'Visible actions do not cause horizontal page overflow');
  checks.push('Article cards show title, synopsis and all actions before hover/focus on desktop and touch layouts');

  card.querySelector<HTMLButtonElement>('.dc-action--explore')!.click();
  await waitFor(() => document.querySelector('.dc-explore__panel') !== null);
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('.dc-explore__action')].find(b => b.textContent?.includes('Social post'))!;
  check(trigger !== undefined, 'Explore offers a social post action');
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
  checks.push('Explore social draft, clipboard paragraphs, Published workflow, explicit workflow failure and retry');
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
  document.querySelector<HTMLButtonElement>('.dc-explore__close')?.click();
  await waitFor(() => document.querySelector('.dc-explore__panel') === null);
  checks.push('Clipboard denial, generation failure and retry, focus restoration');
  openList('inbox');
  await waitFor(() => document.querySelector('.dc-email') !== null);
  const firstEmail = document.querySelector<HTMLElement>('.dc-email')!;
  check(firstEmail.querySelector('.dc-email__mailbox-name')?.textContent === 'Blog'
    && firstEmail.querySelector('.dc-email__mailbox-address')?.textContent === 'richard.hogan@themicrosoftcloudblog.com',
    'Each email names the mailbox and address it came from');
  check(firstEmail.querySelector('.dc-email__subject')?.textContent === 'Cloud news by email', 'Mailbox prefix is removed from the subject');
  check(firstEmail.querySelector('.dc-email__sender')?.textContent === 'Contoso News', 'Sender shows the display name');
  check(!firstEmail.textContent!.includes('From:'), 'No duplicated "From … on …" preview');
  check(firstEmail.classList.contains('dc-email--unread') && getComputedStyle(firstEmail).borderLeftWidth === '3px', 'Unread mail and mailbox colour rail');
  check(parseFloat(getComputedStyle(firstEmail.querySelector('.dc-email__subject')!).fontSize) >= 16.5, 'Readable subject size');
  check(firstEmail.querySelector('a[href="https://outlook.office.com/mail/id/example"]') !== null, 'Open in Outlook link');
  el<HTMLButtonElement>('.dc-inbox-filter[data-mailbox="podcast"]').click();
  await waitFor(() => document.querySelectorAll('.dc-email').length === 1);
  check(document.querySelector('.dc-email__mailbox-name')?.textContent === 'Podcast', 'Mailbox filter shows only that mailbox');
  el<HTMLButtonElement>('.dc-inbox-filter:not([data-mailbox])').click();
  await waitFor(() => document.querySelectorAll('.dc-email').length === 2);
  check(document.documentElement.scrollWidth <= window.innerWidth, 'Inbox fits the viewport');
  checks.push('Inbox shows the source mailbox, sender, subject and mailbox filter');
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
  click('For you');
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
  api.getCfpItems = async () => failure();
  openList('cfps');
  await waitFor(() => document.body.textContent?.includes('Discovery feed is unavailable') === true);
  check(document.querySelector('.dc-empty') === null, 'Failed CFP read cannot claim no calls for papers');
  api.getCfpItems = async () => success([]);
  click('Retry');
  await waitFor(() => document.querySelector('.kh-data-notice') === null && document.querySelector('.dc-empty') !== null);
  checks.push('False article, inbox and CFP envelopes show scoped Retry notices rather than false-empty feeds');
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
  const saveCfp = el<HTMLButtonElement>('.dc-card--cfp .dc-action--save');
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
  openList('published');
  await waitFor(() => document.querySelector('.dc-published-url-input') !== null);
  let urlWrites = 0;
  let urlFailure = true;
  api.updateDiscoverPublishedUrl = async () => {
    urlWrites++;
    await new Promise(resolve => setTimeout(resolve, 100));
    return urlFailure ? failure() : success({});
  };
  const urlInput = el<HTMLInputElement>('.dc-published-url-input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(urlInput, 'https://example.com/retained-post');
  urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  const saveUrl = el<HTMLButtonElement>('.dc-published-url-save');
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
