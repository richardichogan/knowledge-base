import type { QueryClient } from '@tanstack/react-query';
import { api } from '../src/services/api';
import type { ApiResponse } from '../src/types/apiResponse';
import type { Watchlist, WatchlistInput, WatchRun, InterestWeight } from '../src/types/watchlists';
import { projectPickerProjects } from './projectPickerFixtures';

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
  const scope = document.querySelector('dialog[open]') ?? document;
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text);
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

export async function runWatchlistProjectChecks(queryClient: QueryClient): Promise<string[]> {
  let saved: Watchlist[] = [];
  api.getProjects = async () => ok(projectPickerProjects);
  api.getWatchlists = async () => ok(saved);
  api.listDiscoveryFeeds = async () => ok([]);
  api.getWatchlistRuns = async () => ok([]);
  api.getWatchlistBaselines = async () => ok([]);
  api.saveWatchlist = async config => {
    const watchlist: Watchlist = { id: 'picker-watchlist', config, revision: 1, baselineVersion: 1,
      nextRunAt: now, createdAt: now, updatedAt: now, lastRun: null };
    saved = [watchlist];
    return ok(watchlist);
  };
  queryClient.removeQueries({ queryKey: ['projects'] });
  queryClient.removeQueries({ queryKey: ['watchlists'] });
  await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Watchlists'));
  button('Watchlists').click();
  await waitFor(() => document.querySelector('.dw-empty') !== null);
  button('New watchlist').click();
  await waitFor(() => document.querySelectorAll('.dw-project-group').length === 4);
  check(JSON.stringify([...document.querySelectorAll('.dw-project-group legend')].map(legend => legend.textContent))
    === JSON.stringify(['IBM', 'Nelfin', 'Personal', 'Other']), 'Watchlist projects use the shared parent hierarchy');
  const checkbox = (name: string): HTMLInputElement => {
    const field = [...document.querySelectorAll('.dw-project-group label')]
      .find(label => label.textContent?.trim() === name)?.querySelector<HTMLInputElement>('input');
    check(field, `Missing project checkbox: ${name}`);
    return field;
  };
  check(![...document.querySelectorAll('.dw-project-group label')].some(label => /ATOM|ACRE/.test(label.textContent ?? '')),
    'Watchlist projects hide unselected archived and completed projects');
  checkbox('IMAGINE').click();
  checkbox('Healthwise').click();
  await setField('Name', 'Project picker watchlist');
  await setField('Monitoring question', 'What changed for these projects?');
  await setField('Comparison criteria', 'Availability');
  fill(document.querySelector<HTMLInputElement>('[aria-label="Competitor 1"]')!, 'Fixture competitor');
  await waitFor(() => !button('Save watchlist').disabled);
  button('Save watchlist').click();
  await waitFor(() => document.querySelector('#watchlist-form') === null && saved.length === 1);
  check(JSON.stringify(saved[0]?.config.projectIds) === JSON.stringify(['imagine', 'healthwise']),
    'Grouped watchlist selection saves original project IDs');
  saved = [{ ...saved[0]!, config: { ...saved[0]!.config, projectIds: ['atom', 'acre'] } }];
  queryClient.setQueryData(['watchlists'], saved);
  await waitFor(() => document.querySelector('.dw-detail')?.textContent?.includes('atom') === true);
  button('Edit watchlist').click();
  await waitFor(() => document.querySelector('#watchlist-form') !== null);
  check(checkbox('ATOM').checked && checkbox('ACRE').checked, 'Existing archived and completed selections remain visible and checked');
  const form = document.querySelector<HTMLElement>('#watchlist-form')!;
  check(form.scrollWidth <= form.clientWidth + 1, 'Grouped watchlist projects fit the responsive form');
  button('Close').click();
  return ['Watchlist projects share parent groups, preserve saved IDs and fit desktop/phone forms',
    'Existing archived and completed watchlist selections remain visible and checked'];
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
  await waitFor(() => document.querySelector('.dw-empty')?.textContent?.includes('No saved watchlists yet.') === true);
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
  const nowSection = (): HTMLElement => document.querySelector<HTMLElement>('.dw-now')!;
  const tab = (name: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('.dw-company-tab')].find(t => t.querySelector('.dw-company-tab__name')?.textContent === name);
    check(found, `Missing company tab ${name}`);
    return found;
  };
  const setup = (summary: string): HTMLDetailsElement => {
    const found = [...document.querySelectorAll<HTMLDetailsElement>('.dw-setup > details')].find(d => d.querySelector('summary')?.textContent?.startsWith(summary));
    check(found, `Missing setup section ${summary}`);
    return found;
  };
  await waitFor(() => nowSection()?.innerText.includes('No checks yet') === true);
  check(nowSection().querySelector('h4')?.textContent === 'What you need to know now' && nowSection().innerText.includes('No checks yet'), 'A new watchlist leads with an honest empty briefing');
  check(tab('Chosen Product').innerText.includes('Not checked yet') && tab('Chosen Product').getAttribute('aria-selected') === 'true', 'Configured companies are listed before their first check');
  check(!setup('Monitoring brief').open, 'Monitoring setup is collapsed below the briefing');
  check(nowSection().compareDocumentPosition(document.querySelector('.dw-companies')!) & Node.DOCUMENT_POSITION_FOLLOWING
    && document.querySelector('.dw-companies')!.compareDocumentPosition(document.querySelector('.dw-setup')!) & Node.DOCUMENT_POSITION_FOLLOWING,
  'Briefing comes first, then the company breakdown, then setup and history');
  checks.push('Watchlist validation, draft recovery, blank-row normalization and duplicate-submit protection preserve entries through a failed save');

  const runNow = button('Run now');
  runNow.click();
  runNow.click();
  await waitFor(() => document.body.innerText.includes('Monitoring could not start'));
  check(runCalls === 1, 'Concurrent run clicks are locked');
  failRun = false;
  button('Run now').click();
  await waitFor(() => document.querySelector('.dw-now__item') !== null);
  const item = document.querySelector<HTMLElement>('.dw-now__item')!;
  check(item.innerText.includes('Chosen Product · Claims processing') && item.innerText.includes('Newly observed capability')
    && item.innerText.includes('Challenges the explicit comparison.'), 'Now section states the company, claim kind, change and why it matters');
  check(nowSection().innerText.includes('One newly observed announcement') && nowSection().innerText.includes('Meaningful changes'), 'Now section carries the stored summary and status');
  check(tab('Chosen Product').innerText.includes('1 development') && tab('Chosen Product').getAttribute('aria-selected') === 'true', 'Company with developments is selected');
  const rail = document.querySelector<HTMLElement>('.dw-project-insights');
  check(rail && rail.innerText.includes('IMAGINE') && rail.innerText.includes('Possible relevance'), 'Briefing groups grounded project implications and labels inference');
  check(rail?.innerText.includes('saved overlap assessment') && !rail.innerText.includes('Medium relevance')
    && document.querySelector('.dw-rail')?.textContent?.includes('No evidence-grounded watch signals were saved'),
  'Legacy overlap certainty is never silently relabelled as material relevance or invented watch signals');
  const findingId = `finding-${runs[0]?.id}-finding-id`;
  const finding = document.getElementById(findingId)!;
  check(finding && !finding.querySelector('details')!.open && !finding.innerText.includes('Azure is explicitly named'), 'Finding detail is progressive');
  rail.querySelector<HTMLButtonElement>('.dw-link-button')!.click();
  await waitFor(() => document.activeElement === finding && finding.querySelector('details')!.open);
  check(finding.innerText.includes('Azure is explicitly named') && finding.innerText.includes('Not proof of availability.')
    && finding.innerText.includes('IMAGINE · Possible relevance'), 'Opened finding shows Microsoft involvement, caveats and project impact');
  check(finding.querySelector('.dw-evidence a')?.getAttribute('href') === 'https://example.com/evidence'
    && finding.innerText.includes('syndicated copies counted once'), 'Each finding cites its own sources; syndication is not corroboration');
  check(!document.body.innerText.includes('Suggested response') && !document.body.innerText.includes('Check supporting documentation.')
    && !document.body.innerText.includes('→ Use case'), 'No rejected suggested response or use-case action');
  check(!setup('Scope and sources').open, 'Full research sources remain collapsed by default');
  checks.push('Now briefing, selected company breakdown, progressive finding detail with per-finding citations and project links');

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
  const baselineDetails = setup('Comparison context');
  baselineDetails.open = true;
  await waitFor(() => baselineDetails.innerText.includes('Version 2') && baselineDetails.innerText.includes('Version 1'));
  failHistory = true;
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => document.body.innerText.includes('Watchlist history unavailable'));
  check(document.querySelector('.dw-finding') !== null && document.querySelector('.dw-now__item') !== null, 'Unavailable refresh does not erase saved findings');
  failHistory = false;
  button('Retry').click();
  await waitFor(() => !document.body.innerText.includes('Watchlist history unavailable'));
  const recorded = runs[0]!;
  const quiet: WatchRun = { ...recorded, id: 'quiet-run', status: 'no_meaningful_change', findings: [], evidence: [],
    summary: 'No new meaningful change in checked feeds.', coverage: { ...recorded.coverage, matched: 0, uniqueEvents: 0 } };
  const uncovered: WatchRun = { ...recorded, id: 'uncovered-run', status: 'insufficient_coverage', findings: [], evidence: [],
    summary: 'Feeds unavailable; no conclusion about market change.', coverage: { ...recorded.coverage, sourcesHealthy: 0, missingEntities: ['Chosen Product'] } };
  runs = [recorded, quiet, uncovered];
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => document.querySelector('.dw-run--no_meaningful_change') !== null && document.querySelector('.dw-run--insufficient_coverage') !== null);
  check(!setup('Earlier checks').open && setup('Earlier checks').querySelector('summary')!.textContent === 'Earlier checks (2)', 'Earlier checks are collapsed and counted');
  check(document.querySelector('.dw-run--no_meaningful_change')!.textContent!.includes('No meaningful change')
    && document.querySelector('.dw-run--insufficient_coverage')!.textContent!.includes('no conclusion'), 'Saved quiet weeks are visibly distinct from unavailable coverage');
  runs = [quiet, recorded];
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => tab('Chosen Product').innerText.includes('No meaningful change found'));
  check(nowSection().innerText.includes('No meaningful change') && document.querySelector('.dw-now__item') === null, 'A quiet latest check is stated without stale developments');
  runs = [uncovered, recorded];
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => tab('Chosen Product').innerText.includes('No evidence found'));
  check(nowSection().innerText.includes('Coverage incomplete') && document.querySelector('.dw-company__note--missing')?.textContent?.includes('not proof of no activity'),
    'Missing evidence is distinguished from no change in the briefing and the company');
  check(!document.querySelector<HTMLDetailsElement>('.dw-coverage')!.open, 'Detailed coverage mechanics start collapsed');
  document.querySelector<HTMLButtonElement>('.dw-rail [aria-label="Coverage summary"] button')!.click();
  await waitFor(() => document.querySelector<HTMLDetailsElement>('.dw-coverage')!.open && document.activeElement?.classList.contains('dw-coverage') === true);
  check(nowSection().innerText.includes('Coverage was incomplete') && nowSection().innerText.includes('No evidence was found for Chosen Product'),
    'Rail coverage link expands and focuses the honest missing-evidence detail');
  document.querySelector<HTMLDetailsElement>('.dw-coverage')!.querySelector<HTMLElement>('summary')!.click();
  runs = [{ ...recorded, id: 'failed-run', status: 'failed', findings: [], evidence: [], summary: 'Search provider unavailable.' }, recorded];
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => nowSection().innerText.includes('failed: Search provider unavailable.'));
  check(nowSection().innerText.includes('Showing the last completed check') && document.querySelector('.dw-now__item') !== null, 'A failed latest check keeps the last completed briefing, labelled');
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  runs = [{ ...recorded, startedAt: old, completedAt: old }];
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => nowSection().innerText.includes('This briefing is 30 days old'));
  checks.push('Version history retains baselines, pause disables execution, failed history retains evidence, and quiet, missing, failed and stale checks differ');

  const finding2 = (entity: string, n: number, field: string): WatchRun['findings'][number] => ({ ...recorded.findings[0]!, id: `${entity}-${n}`, entity,
    changed: `${entity} change ${n}`, field, projectAssessments: [] });
  runs = [{ ...recorded, id: 'multi-run', config: { ...recorded.config, entities: ['Chosen Product', 'Second Co', 'Third Co', 'Fourth Co'].map(name => ({ name, relationship: 'competitor' as const })) },
    coverage: { ...recorded.coverage, missingEntities: ['Fourth Co'] },
    findings: [1, 2, 3, 4].map(n => finding2('Chosen Product', n, n === 1 ? 'Claims processing' : `Field ${n}`))
      .concat([1, 2, 3].map(n => finding2('Second Co', n, n === 1 ? 'Claims processing' : `Other ${n}`))) }];
  await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
  await waitFor(() => document.querySelectorAll('.dw-now__item').length === 5);
  check(JSON.stringify([...document.querySelectorAll('.dw-now__headline')].map(h => h.textContent))
    === JSON.stringify(['Chosen Product change 1', 'Second Co change 1', 'Chosen Product change 2', 'Second Co change 2', 'Chosen Product change 3']),
  'Briefing is bounded and takes one development per company first in watchlist order');
  check(nowSection().innerText.includes('Showing 5 of 7') && nowSection().innerText.includes('Claims processing · Chosen Product, Second Co'), 'Briefing discloses its bound and cross-company fields');
  check(tab('Third Co').innerText.includes('No meaningful change found') && tab('Fourth Co').innerText.includes('No evidence found'), 'Each company states its own coverage outcome');
  check(document.querySelectorAll('.dw-company .dw-finding').length === 4, 'Only the selected company is expanded');
  tab('Chosen Product').focus();
  tab('Chosen Product').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await waitFor(() => document.activeElement === tab('Second Co') && tab('Second Co').getAttribute('aria-selected') === 'true');
  check(document.querySelectorAll('.dw-company .dw-finding').length === 3 && tab('Chosen Product').tabIndex === -1, 'Arrow keys move company selection with a roving tab stop');
  tab('Second Co').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await waitFor(() => document.activeElement === tab('Fourth Co'));
  check(document.querySelector('.dw-company')!.textContent!.includes('No evidence was found for Fourth Co'), 'Selecting a company without evidence explains the gap');
  [...document.querySelectorAll<HTMLButtonElement>('.dw-now__item .dw-link-button')][1]!.click();
  await waitFor(() => tab('Second Co').getAttribute('aria-selected') === 'true' && document.activeElement?.id === 'finding-multi-run-Second_Co-1');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'Watchlist layout fits desktop and mobile viewport');
  checks.push('Many companies stay bounded: round-robin briefing, per-company outcomes, keyboard tabs and briefing-to-company navigation');

  const relevanceStates = ['high', 'medium', 'low', 'no-material-impact', 'insufficient-evidence'] as const;
  const intelligence: WatchRun = { ...recorded, id: 'intelligence-review', summary: 'Chosen Product announced managed claims agents. The capability intersects with IMAGINE’s claims workflow, but published delivery documentation is still needed to establish availability.',
    evidence: recorded.evidence.map(e => ({ ...e, publishedAt: old })),
    findings: [{ ...recorded.findings[0]!, headline: 'Managed claims agents announced',
      evidenceHighlight: { text: 'The source describes managed agents for claims processing.', evidenceIds: [articleId] },
      watchNext: { statement: 'Whether delivery documentation establishes availability and deployment requirements.', evidenceIds: [articleId] },
      projectAssessments: relevanceStates.map((relevance, index) => ({
        projectId: `project-${index}`, projectName: ['IMAGINE', 'Claims pilot', 'Research', 'Personal learning', 'Unspecified project'][index]!,
        relevance, impact: [
          'Claims agents intersect directly with IMAGINE’s saved claims-processing goal; delivery remains unconfirmed.',
          'The documented claims workflow intersects with the pilot; the deployment model remains unclear.',
          'Only the documented agent-orchestration element intersects with the research scope.',
          'This project concerns personal study, not claims processing; no material intersection is identified.',
          'Project context is too limited to establish the relevance of the claimed capability.',
        ][index]!,
        ...(index === 0 ? { watchNext: 'Whether public documentation establishes the delivery model.' } : {}),
      })),
    }],
  };
  const showIntelligence = async (): Promise<void> => {
    runs = [intelligence, recorded];
    await queryClient.invalidateQueries({ queryKey: ['watchlist-runs'] });
    await waitFor(() => document.querySelector('.dw-now__headline')?.textContent === 'Managed claims agents announced');
    document.querySelector<HTMLElement>('.watchlists')!.scrollTop = 0;
  };
  await showIntelligence();
  const impactDetails = document.querySelector<HTMLDetailsElement>('.dw-project-insights > details')!;
  impactDetails.open = true;
  check(document.querySelector('.dw-now__lead')!.textContent === '1 competitor development worth your attention', 'Lead count comes from the saved findings');
  check(['High relevance', 'Medium relevance', 'Low relevance', 'No material impact identified', 'Insufficient evidence']
    .every(label => document.querySelector('.dw-project-insights')!.textContent!.includes(label)), 'All five material relevance meanings remain distinct');
  check(nowSection().innerText.indexOf(intelligence.summary) < nowSection().innerText.indexOf('Meaningful changes'),
    'Intelligence synthesis precedes coverage mechanics');
  check(document.querySelector('.dw-now__evidence')?.textContent?.includes('The source describes managed agents')
    && document.querySelector('.dw-rail [aria-label="Watch next"]')?.textContent?.includes('Whether delivery documentation'),
    'Saved evidence and monitoring signals appear in their intended reading positions');
  check(!document.querySelector('.dw-now__headline')!.textContent!.includes('Newly observed'), 'Signal headline is not overwritten with observation boilerplate');
  document.querySelector<HTMLButtonElement>('.dw-rail__project')!.click();
  await waitFor(() => document.activeElement?.classList.contains('dw-project-insights__group') === true);
  check(document.activeElement?.textContent?.includes('IMAGINE'), 'Compact impact links focus their corresponding detailed project assessment');
  document.querySelector<HTMLButtonElement>('.dw-rail [aria-label="Watch next"] button')!.click();
  const enrichedFinding = document.getElementById('finding-intelligence-review-finding-id')!;
  await waitFor(() => document.activeElement === enrichedFinding && enrichedFinding.querySelector('details')!.open);
  check(enrichedFinding.innerText.includes(new Date(old).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })),
    'Source publication date stays historical even when the observation is current');
  const scrollOwner = document.querySelector<HTMLElement>('.watchlists')!;
  const grid = document.querySelector<HTMLElement>('.dw-intelligence')!;
  const main = document.querySelector<HTMLElement>('.dw-intelligence__main')!;
  const context = document.querySelector<HTMLElement>('.dw-rail')!;
  const mainWidth = main.getBoundingClientRect().width;
  const proportion = mainWidth / (mainWidth + context.getBoundingClientRect().width);
  check(proportion >= .68 && proportion <= .72, `Intelligence uses 68–72% of desktop columns (actual ${proportion})`);
  const summaryStyle = getComputedStyle(document.querySelector('.dw-now__summary')!);
  const measuringCanvas = document.createElement('canvas');
  const measurement = measuringCanvas.getContext('2d')!;
  measurement.font = `${summaryStyle.fontSize} ${summaryStyle.fontFamily}`;
  check(document.querySelector('.dw-now__summary')!.getBoundingClientRect().width <= measurement.measureText('0').width * 72 + 2,
    'Summary text is bounded to 72 characters, not stretched across the viewport');
  scrollOwner.scrollTop += grid.getBoundingClientRect().top - scrollOwner.getBoundingClientRect().top + 350;
  await new Promise(resolve => requestAnimationFrame(resolve));
  check(scrollOwner.scrollTop > 0 && Math.abs(context.getBoundingClientRect().top - scrollOwner.getBoundingClientRect().top - 16) < 2,
    'Context rail sticks inside the actual application scroll owner');
  document.querySelector<HTMLElement>('.dw-project-insights')!.scrollIntoView({ block: 'start' });
  await new Promise(resolve => requestAnimationFrame(resolve));
  check(Math.abs(context.getBoundingClientRect().top - scrollOwner.getBoundingClientRect().top - 16) < 2,
    'Context stays visible while reading the detailed project implications');
  const sizeRule = document.createElement('style');
  document.head.append(sizeRule);
  for (const width of [768, 390]) {
    sizeRule.textContent = `.watchlists { width: ${width}px; }`;
    scrollOwner.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));
    check(context.getBoundingClientRect().top >= main.getBoundingClientRect().bottom - 1 && getComputedStyle(context).position === 'static',
      `Context stacks below the main content at ${width}px container width`);
    const edge = scrollOwner.getBoundingClientRect().left + scrollOwner.clientWidth - parseFloat(getComputedStyle(scrollOwner).paddingRight);
    const overflow = [...scrollOwner.querySelectorAll<HTMLElement>('*')].filter(e => e.getBoundingClientRect().right > edge + 1)
      .slice(0, 8).map(e => `${e.tagName}.${e.className}: ${e.getBoundingClientRect().width.toFixed(0)}px`).join(', ');
    check(scrollOwner.scrollWidth <= scrollOwner.clientWidth + 1, `Narrow ${width}px briefing has no horizontal overflow (${scrollOwner.scrollWidth}/${scrollOwner.clientWidth}; grid ${grid.scrollWidth}/${grid.clientWidth}): ${overflow}`);
  }
  sizeRule.remove();
  scrollOwner.scrollTop = 0;
  impactDetails.open = false;
  checks.push('Structured intelligence leads with supported headlines and evidence, five distinct project relevance states, linked watch signals and honest publication dates',
    'Measured 70/30 desktop columns, 72ch summary measure, real scroll-owner stickiness and stacked 768/390px containers without overflow');
  Object.assign(window, { prepareWatchlistReview: async () => {
    button('Watchlists').click();
    await showIntelligence();
    return true;
  } });

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
