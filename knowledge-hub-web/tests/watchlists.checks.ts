import type { QueryClient } from '@tanstack/react-query';
import { api } from '../src/services/api';
import type { ApiResponse } from '../src/types/apiResponse';
import type { Watchlist, WatchlistInput, WatchRun, InterestWeight } from '../src/types/watchlists';

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const sourceId = '11111111-1111-4111-8111-111111111111';
const articleId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const now = new Date().toISOString();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function waitFor(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Watchlist fixture timed out: ${document.body.innerText}`);
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text);
  check(found, `Missing watchlist button ${text}`);
  return found;
}
function input(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const found = [...document.querySelectorAll('label')].find(l => l.textContent?.startsWith(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select');
  check(found, `Missing field ${label}`);
  return found;
}
function fill(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function setField(label: string, value: string): Promise<void> {
  fill(input(label), value);
  await new Promise(resolve => setTimeout(resolve, 10));
}

export async function runWatchlistChecks(queryClient: QueryClient): Promise<string[]> {
  const checks: string[] = [];
  document.querySelector<HTMLButtonElement>('.dc-action--explore')!.click();
  await waitFor(() => document.querySelector('.dc-explore__panel') !== null);
  check(document.querySelector('.dc-explore__panel')!.textContent!.includes('Matched topic: agents ×1.5'), 'Every article can show its server-computed interest pick reason');
  document.querySelector<HTMLButtonElement>('.dc-explore__close')!.click();
  await waitFor(() => document.querySelector('.dc-explore__panel') === null);
  let saved: Watchlist[] = [];
  let runs: WatchRun[] = [];
  const baselineHistory: Array<{ version: number; baseline: WatchlistInput['baseline']; createdAt: string }> = [];
  let weights: InterestWeight[] = [];
  let saves = 0;
  let runCalls = 0;
  let failSave = true;
  let failRun = true;
  let failHistory = false;
  api.getProjects = async () => ok([]);
  api.listUseCases = async () => ok([]);
  api.listDiscoveryFeeds = async () => ok([{ id: sourceId, title: 'User selected feed', feedUrl: 'https://example.com/rss',
    groupName: 'User group', isActive: true, lastCheckedAt: now, lastSuccessAt: now, lastError: null, lastNewCount: 1, articlesFound: 1 }]);
  api.getWatchlists = async () => ok(saved);
  api.getWatchlistRuns = async () => {
    if (failHistory) throw new Error('History fixture unavailable');
    return ok(runs);
  };
  api.getWatchlistBaselines = async () => ok(baselineHistory);
  api.saveWatchlist = async (config, existing) => {
    saves++;
    await new Promise(resolve => setTimeout(resolve, 80));
    if (failSave) throw new Error('Save fixture unavailable');
    const old = saved[0];
    const version = old ? old.baselineVersion + Number(JSON.stringify(old.config.baseline) !== JSON.stringify(config.baseline)) : 1;
    const w: Watchlist = { id: existing?.id ?? '22222222-2222-4222-8222-222222222222', config,
      revision: (existing?.revision ?? 0) + 1, baselineVersion: version, nextRunAt: now, createdAt: now, updatedAt: now, lastRun: null };
    if (!baselineHistory.some(b => b.version === version)) baselineHistory.unshift({ version, baseline: config.baseline, createdAt: now });
    saved = [w];
    return ok(w);
  };
  api.runWatchlist = async id => {
    runCalls++;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (failRun) throw new Error('Claim fixture conflict');
    const w = saved[0]!;
    const run: WatchRun = { id: '33333333-3333-4333-8333-333333333333', watchlistId: id, baselineVersion: w.baselineVersion,
      baseline: w.config.baseline, config: w.config, startedAt: now, completedAt: now, windowStart: now,
      status: 'changes', summary: 'One newly observed announcement; availability is not confirmed.',
      coverage: { matched: 2, uniqueEvents: 1, sourcesChecked: 1, sourcesHealthy: 1, missingEntities: [], truncated: false },
      evidence: [{ id: articleId, title: 'Evidence announcement', url: 'https://example.com/evidence', publishedAt: now,
        excerpt: 'Public source evidence', eventKey: 'one-event', syndicatedIds: ['duplicate-id'], entities: ['Chosen Product'] }],
      findings: [{ id: 'finding-id', entity: 'Chosen Product', criterion: 'Availability', kind: 'announced-capability',
        changed: 'Newly observed capability', matters: 'Challenges the explicit comparison.', uncertainty: 'Not proof of availability.',
        response: 'Check supporting documentation.', evidenceIds: [articleId], field: 'Claims processing',
        microsoftInvolvement: 'Azure is explicitly named in the announcement.',
        projectImpact: 'Potential overlap with IMAGINE claims processing.',
        projectAssessments: [{ projectId: 'imagine', projectName: 'IMAGINE', relationship: 'possible-relevance',
          impact: 'Potential overlap with IMAGINE claims processing; delivery is not confirmed.' }] }],
    };
    runs = [run];
    return ok(run);
  };
  api.getDiscoverInterests = async () => ok(weights);
  api.saveDiscoverInterest = async value => {
    weights = [...weights.filter(w => w.kind !== value.kind || w.term !== value.term), value];
    return ok(weights);
  };
  api.getFilteredDiscover = async () => {
    const response = await api.getDiscoverFeed();
    check(response.success, 'Article fixture available for filtered test');
    return ok({ items: response.data.items.map(item => ({ ...item, filteredReason: 'A matching topic has weight zero.' })), total: 1 });
  };

  button('Watchlists').click();
  await waitFor(() => document.body.innerText.includes('No watchlists yet.'));
  button('New watchlist').click();
  await waitFor(() => document.querySelector('#watchlist-form') !== null);
  check(input('Name').value === '' && input('Our position').value === '', 'No invented baseline or first watchlist');
  button('Save watchlist').click();
  await waitFor(() => document.body.innerText.includes('Enter a watchlist name.'));
  check(document.activeElement === input('Name'), 'Invalid save focuses the blocking field');
  await setField('Name', 'A question-led watchlist');
  await setField('Monitoring question', 'Does this change our proposition?');
  await setField('Comparison criteria', 'Availability\nTarget buyer');
  const entity = document.querySelector<HTMLInputElement>('[aria-label="Competitor 1"]')!;
  fill(entity, 'Chosen Product');
  await new Promise(resolve => setTimeout(resolve, 20));
  button('Add competitor').click();
  await waitFor(() => document.querySelector('[aria-label="Competitor 2"]') !== null);
  button('Close').click();
  await waitFor(() => document.querySelector('#watchlist-form') === null && document.body.innerText.includes('Unsaved draft'));
  button('Continue editing').click();
  await waitFor(() => document.querySelector('#watchlist-form') !== null);
  check(input('Name').value === 'A question-led watchlist', 'Closing and reopening restores entered watchlist');
  check(input('Our position').value === '', 'Manual baseline is optional');
  await setField('Our position', 'Private original proposition');
  const source = [...document.querySelectorAll('label')].find(l => l.textContent?.includes('User selected feed'))?.querySelector<HTMLInputElement>('input')!;
  source.click();
  await waitFor(() => !button('Save watchlist').disabled);
  button('Save watchlist').click();
  button('Save watchlist').click();
  await waitFor(() => document.body.innerText.includes('Watchlist was not saved'));
  check(saves === 1 && input('Our position').value === 'Private original proposition', 'Failed save preserves the explicit baseline and ignores duplicate submit');
  failSave = false;
  button('Save watchlist').click();
  await waitFor(() => document.querySelector('#watchlist-form') === null && document.querySelector('.dw-detail') !== null);
  check(saved[0]?.config.entities.length === 1 && saved[0]?.config.entities[0]?.name === 'Chosen Product' && saved[0]?.config.sourceIds[0] === sourceId, 'Blank competitor rows are ignored and configured entities persist');
  check(document.body.innerText.includes('saved') && !document.body.innerText.includes('Unsaved draft'), 'Saved watchlist replaces its retained draft');
  const brief = [...document.querySelectorAll<HTMLDetailsElement>('.dw-detail > details')].find(detail => detail.querySelector('summary')?.textContent === 'Monitoring brief');
  check(brief && !brief.open, 'Long monitoring brief is collapsed above the latest analysis');
  checks.push('Watchlist validation, draft recovery, blank-row normalization and duplicate-submit protection preserve entries through a failed save');

  const runNow = button('Run now');
  runNow.click();
  runNow.click();
  await waitFor(() => document.body.innerText.includes('Monitoring could not start'));
  check(runCalls === 1, 'Concurrent run clicks are locked');
  failRun = false;
  button('Run now').click();
  await waitFor(() => document.querySelector('.dw-finding') !== null);
  check(document.body.innerText.includes('Announced capability') && document.body.innerText.includes('Azure is explicitly named'), 'Claim kind and Microsoft involvement are visible');
  const rail = document.querySelector<HTMLElement>('.dw-project-insights');
  check(rail?.innerText.includes('IMAGINE') && rail.innerText.includes('Possible relevance'), 'Right column groups grounded project implications and labels inference');
  check(rail.querySelector('a')?.hash === `#finding-${runs[0]?.id}-finding-id`, 'Project implication links to the exact competitor finding');
  const layout = document.querySelector('.dw-report-layout')!;
  check(getComputedStyle(layout).display === 'grid', 'Analysis uses an intentional grid layout');
  if (window.innerWidth >= 1280) check(rail.getBoundingClientRect().left > document.querySelector('.dw-finding')!.getBoundingClientRect().right, 'Project implications occupy the right-hand space');
  check(!document.body.innerText.includes('Suggested response') && !document.body.innerText.includes('→ Use case'), 'No rejected suggested response or use-case action');
  check(document.querySelector('.dw-evidence a')?.getAttribute('href') === 'https://example.com/evidence', 'Finding links to evidence');
  check(document.body.innerText.includes('syndicated copies counted once'), 'Syndication is not corroboration');
  checks.push('Competitor activity, field, Microsoft involvement and a linked project-impact column without rejected actions');

  button('Edit watchlist').click();
  await waitFor(() => document.querySelector('#watchlist-form') !== null);
  await setField('Our position', 'Private revised proposition');
  const paused = input('Paused') as HTMLInputElement;
  paused.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  button('Save watchlist').click();
  await waitFor(() => document.querySelector('#watchlist-form') === null && saved[0]?.baselineVersion === 2);
  check(button('Run now').disabled, 'Paused watchlists cannot run');
  check(runs[0]?.baselineVersion === 1 && runs[0]?.baseline.text === 'Private original proposition', 'Old dated run retains the original comparison version');
  const baselineDetails = [...document.querySelectorAll<HTMLDetailsElement>('.dw-detail > details')].find(detail => detail.querySelector('summary')?.textContent?.includes('Comparison context'))!;
  baselineDetails.open = true;
  await waitFor(() => baselineDetails.innerText.includes('Version 2') && baselineDetails.innerText.includes('Version 1'));
  failHistory = true;
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => document.body.innerText.includes('Watchlist history unavailable'));
  check(document.querySelector('.dw-finding') !== null, 'Unavailable refresh does not erase saved findings');
  failHistory = false;
  button('Retry').click();
  await waitFor(() => !document.body.innerText.includes('Watchlist history unavailable'));
  const recorded = runs[0]!;
  runs = [recorded, { ...recorded, id: 'quiet-run', status: 'no_meaningful_change', findings: [], evidence: [],
    summary: 'No new meaningful change in checked feeds.', coverage: { ...recorded.coverage, matched: 0, uniqueEvents: 0 } },
  { ...recorded, id: 'uncovered-run', status: 'insufficient_coverage', findings: [], evidence: [],
    summary: 'Feeds unavailable; no conclusion about market change.', coverage: { ...recorded.coverage, sourcesHealthy: 0, missingEntities: ['Chosen Product'] } }];
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => document.querySelector('.dw-run--no_meaningful_change') !== null && document.querySelector('.dw-run--insufficient_coverage') !== null);
  check(document.querySelector('.dw-run--no_meaningful_change')!.textContent!.includes('No meaningful change')
    && document.querySelector('.dw-run--insufficient_coverage')!.textContent!.includes('no conclusion'), 'Saved quiet weeks are visibly distinct from unavailable coverage');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'Watchlist layout fits desktop and mobile viewport');
  checks.push('Version history retains baselines, pause disables execution, failed history retains evidence, and quiet weeks differ from missing coverage');

  button('Interests').click();
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  await setField('Topic text', 'agents');
  await setField('Weight', '0');
  button('Save weight').click();
  await waitFor(() => document.querySelector('.dw-weights')?.textContent?.includes('agents ×0') === true);
  await setField('Interest type', 'source');
  await setField('Source name', 'user selected feed');
  await setField('Weight', '2');
  button('Save weight').click();
  await waitFor(() => document.querySelector('.dw-weights')?.textContent?.includes('user selected feed ×2') === true);
  const sourceWeight = [...document.querySelectorAll('.dw-weights li')].find(li => li.textContent?.includes('source: user selected feed'))!;
  sourceWeight.querySelector<HTMLButtonElement>('button')!.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  check(input('Source name').value === 'user selected feed', 'Stored normalized source weights remain selectable when edited');
  button('What was filtered out this week?').click();
  await waitFor(() => document.querySelector('.dw-filtered-item') !== null);
  check(document.querySelector('.dw-filtered-item')!.textContent!.includes('topic has weight zero'), 'Filtered item explains why it was excluded');
  button('Done').click();
  await waitFor(() => document.querySelector('dialog') === null);
  button('Interests').click();
  await waitFor(() => document.querySelector('.dw-weights')?.textContent?.includes('agents ×0') === true);
  check(weights[0]?.weight === 0, 'Interest is restored from API when controls reopen');
  button('Done').click();
  await waitFor(() => document.querySelector('dialog') === null);
  button('For you').click();
  await waitFor(() => document.querySelector('.dc-card') !== null);
  checks.push('Server-side interest editing, persisted reload and the filtered-out view with per-item explanations');
  return checks;
}
