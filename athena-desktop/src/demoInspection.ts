import type { DemoStep } from './demoSteps';
import type { locateWorkforceElement } from './workforceInspection';

export interface DemoPair { jobPath?: string; scopeId?: string; orderId?: string; historicalReturn?: string }
export interface InspectionTarget {
  x: number; y: number; mode: 'point' | 'hover' | 'click' | 'done' | 'fill';
  key: string; pair: DemoPair; message?: string;
  destination?: string;
  value?: string;
}

// Runs in the isolated demo page. Only the named, read-only targets below can receive a click.
export function locateInspection(step: DemoStep, pair: DemoPair, scroll: boolean, workforce?: typeof locateWorkforceElement): InspectionTarget | null {
  const visible = (el: Element | null): el is HTMLElement => !!el && el instanceof HTMLElement
    && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const all = (selector: string, root: ParentNode = document): HTMLElement[] =>
    Array.from(root.querySelectorAll(selector)).filter(visible);
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const named = (selector: string, name: string, root: ParentNode = document): HTMLElement | null =>
    all(selector, root).find(el => text(el).toLowerCase().startsWith(name.toLowerCase())) ?? null;
  const heading = (name: string): HTMLElement | null => named('h2,h3,h4,h5', name);
  const panel = (name: string): HTMLElement | null => heading(name)?.closest<HTMLElement>('section,article,.cds--tile') ?? null;
  const byId = (id: string): HTMLElement | null => all(`[data-demo-id="${id}"]`)[0] ?? null;
  const link = (path: string, root: ParentNode = document): HTMLElement | null =>
    all('a[href]', root).find(el => {
      const url = new URL(el.getAttribute('href')!, location.href);
      return url.origin === location.origin && url.pathname === path;
    }) ?? null;
  const tab = (label: string): HTMLElement | null => named('[role="tab"]', label);
  const summary = (label: string): HTMLElement | null => named('summary', label);
  let el: HTMLElement | null = null;
  let mode: InspectionTarget['mode'] = 'point';
  let message: string | undefined;
  let value: string | undefined;
  const next = { ...pair };
  const clickUnless = (target: HTMLElement | null, done: boolean): void => {
    el = target; mode = done ? 'point' : 'click';
  };
  const orderPath = pair.orderId ? `/turnaround/work-orders/${encodeURIComponent(pair.orderId)}` : null;
  const rowForOrder = (): HTMLElement | null => orderPath ? link(orderPath)?.closest('tr') ?? null : null;
  const rows = (): HTMLElement[] => all('[data-demo-id="turnaround-plan-jobs"] tbody tr')
    .filter(row => !!row.querySelector('button[aria-label^="Show work orders for "]'));
  const selectedJobRow = (): HTMLElement | null => rows().find(row => !!pair.jobPath && !!link(pair.jobPath, row)) ?? null;
  if (step.startsWith('workforce-')) {
    if (!workforce) throw new Error('This Desktop does not support workforce walkthroughs.');
    const target = workforce(step);
    el = target.el; mode = target.mode ?? 'point'; message = target.message; value = target.value;
  } else switch (step) {
    case 'event':
      el = all('select').find(select => Array.from((select as HTMLSelectElement).selectedOptions)
        .some(option => /NPT2/.test(option.text))) ?? null;
      if (!el) throw new Error('Select NPT2-TA-2027 before this walkthrough. No event was changed.');
      break;
    case 'standing': el = byId('turnaround-standing'); break;
    case 'funnel': el = heading('Scope funnel'); break;
    case 'waiting': el = all('h3').find(item => /^Waiting on\b/.test(text(item))) ?? null; break;
    case 'activity': el = heading('Agent activity'); break;
    case 'lifecycle':
      el = all('nav,[role="navigation"]').find(item => !!link('/turnaround/plan', item) && !!link('/turnaround/twin', item))
        ?? link('/turnaround/plan')?.closest<HTMLElement>('ol,ul,div') ?? null;
      break;
    case 'steward':
      el = byId('turnaround-steward-panel');
      if (!el) { el = all('[aria-label="Open Turnaround Digital Steward"]')[0] ?? null; mode = 'click'; }
      break;
    case 'plan-expand': {
      const row = all('table[aria-label="Five-year turnaround plan"] tr').find(item =>
        text(item).includes('This demo') && !!item.querySelector('button.turnaround-plan__link-toggle'));
      const button = row?.querySelector<HTMLElement>('button[aria-expanded]') ?? null;
      clickUnless(button, button?.getAttribute('aria-expanded') === 'true');
      break;
    }
    case 'plan-job-expand': {
      const row = pair.jobPath ? selectedJobRow() : rows().find(item => {
        const cells = item.querySelectorAll('td');
        return cells.length > 4 && Number(cells[4]?.textContent?.trim()) > 0;
      });
      if (!row) break;
      const job = all('a[href]', row).find(item => new URL(item.getAttribute('href')!, location.href).pathname.startsWith('/turnaround/items/'));
      if (!job) break;
      next.jobPath = new URL(job.getAttribute('href')!, location.href).pathname;
      next.scopeId = text(job);
      const button = row.querySelector<HTMLElement>('button[aria-expanded]');
      clickUnless(button, button?.getAttribute('aria-expanded') === 'true');
      break;
    }
    case 'plan-orders': el = byId('turnaround-plan-work-orders'); break;
    case 'order-open': {
      if (orderPath && location.pathname === orderPath) { el = byId('turnaround-work-order'); mode = 'done'; break; }
      const list = byId('turnaround-plan-work-orders') ?? byId('turnaround-work-orders');
      if (!list) break;
      el = orderPath ? link(orderPath, list) : all('tbody tr', list).filter(row => {
        const cells = row.querySelectorAll('td');
        return !!cells[5]?.textContent?.trim() && !/^[—-]$/.test(cells[5].textContent.trim());
      }).flatMap(row => all('a[href]', row)).find(item =>
        new URL(item.getAttribute('href')!, location.href).pathname.startsWith('/turnaround/work-orders/')) ?? null;
      if (el) next.orderId = decodeURIComponent(new URL(el.getAttribute('href')!, location.href).pathname.split('/').pop()!);
      mode = 'click'; break;
    }
    case 'order-sap':
      el = byId('turnaround-wo-sap');
      if (!el) {
        el = named('p', 'No scope-addition recommendations');
        if (el) message = 'No proposal source work order is available.';
      }
      break;
    case 'order-evidence-open':
    case 'order-evidence': {
      const evidence = panel('Link evidence');
      if (!evidence) break;
      if (pair.jobPath && !link(pair.jobPath, evidence)) throw new Error('The saved job is not linked in this work order’s evidence. No other pair was substituted.');
      el = evidence; break;
    }
    case 'order-related':
      el = byId('turnaround-wo-related') ?? named('p', 'No scope-addition recommendations');
      if (el && !byId('turnaround-wo-related')) message = 'No proposal source exists to inspect. No proposal was generated.';
      break;
    case 'proposal-expand': {
      const button = named('button[aria-expanded]', 'AI-recommended scope additions');
      if (button) clickUnless(button, button.getAttribute('aria-expanded') === 'true');
      else {
        el = named('p', 'No scope-addition recommendations');
        if (el) { mode = 'done'; message = 'No scope-addition recommendation is recorded. No proposal was generated.'; }
      }
      break;
    }
    case 'proposal-source':
      el = byId('turnaround-scope-addition')?.querySelector<HTMLElement>('a[href]') ?? null;
      if (!el) {
        el = named('p', 'No scope-addition recommendations');
        if (el) message = 'No scope-addition proposals are recorded. None were generated for this demo.';
      } else mode = 'click';
      break;
    case 'proposal-history': {
      const item = summary('Response history');
      if (item) clickUnless(item, item.closest('details')?.open === true);
      else { el = byId('turnaround-scope-addition') ?? named('p', 'No scope-addition recommendations'); message = 'No response history is recorded for the displayed proposal.'; }
      break;
    }
    case 'scope-filter':
      el = all('[aria-label="Work order summary filters"] button')[1] ?? null;
      clickUnless(el, el?.getAttribute('aria-pressed') === 'true'); break;
    case 'scope-work-orders': {
      const tab = all('[data-demo-id="turnaround-queue-tab-work-orders"]')[0] ?? null;
      clickUnless(tab, tab?.getAttribute('aria-selected') === 'true');
      break;
    }
    case 'clear-filters':
      el = named('button', 'Clear filters');
      if (el) mode = 'click';
      else { el = all('[aria-label="Work order summary filters"]')[0] ?? null; mode = 'done'; }
      break;
    case 'waiting-tooltip': {
      const row = rowForOrder();
      const table = row?.closest('table');
      const headers = table ? all('thead th', table) : [];
      const decisionIndex = headers.findIndex(header => text(header).toLowerCase() === 'decision');
      const decision = row && decisionIndex >= 0 ? row.children[decisionIndex] as HTMLElement | undefined : undefined;
      if (!decision) break;
      const waiting = decision.querySelector<HTMLElement>('button.turnaround-bucket-help');
      if (waiting) {
        el = waiting;
        mode = 'hover';
      } else {
        el = decision;
        message = 'No waiting tooltip is available for this selected work order; its recorded decision is shown.';
      }
      break;
    }
    case 'order-challenge': {
      if (!pair.orderId) throw new Error('Choose and inspect the linked work-order/job pair in Plan first.');
      const current = new URL(location.href);
      if (current.pathname === '/turnaround/challenge' && current.searchParams.get('workOrder') === pair.orderId) {
        el = byId('turnaround-wo-challenge'); mode = 'done'; break;
      }
      el = all('a[href]').find(item => {
        const url = new URL(item.getAttribute('href')!, location.href);
        return url.origin === location.origin && url.pathname === '/turnaround/challenge' && url.searchParams.get('workOrder') === pair.orderId;
      }) ?? named('button', 'Open in Scope challenge') ?? named('button', 'Decide in Scope challenge');
      if (!el) el = named('button', 'Show decided');
      mode = 'click'; break;
    }
    case 'challenge-order-evidence': {
      const table = all('table[aria-label="Work-order challenge"]')[0] ?? null;
      const row = table && orderPath ? link(orderPath, table)?.closest('tr') ?? null : null;
      if (!row) throw new Error('The retained work order is not present in the focused challenge evidence. No other order was selected.');
      el = row.querySelector<HTMLElement>('.turnaround-plan__evidence-column') ?? row;
      break;
    }
    case 'challenge-job': {
      const current = new URL(location.href);
      const jobId = pair.jobPath?.split('/').pop();
      if (current.pathname === '/turnaround/challenge' && current.searchParams.get('job') === jobId) {
        el = byId('turnaround-challenge-job-focus'); mode = 'done'; break;
      }
      el = all('a[href]').find(item => {
        const url = new URL(item.getAttribute('href')!, location.href);
        return url.origin === location.origin && url.pathname === '/turnaround/challenge' && url.searchParams.get('job') === jobId;
      }) ?? null; mode = 'click'; break;
    }
    case 'challenge-workbench': el = heading('Challenge workbench'); break;
    case 'historical': el = heading('Historical precedent'); break;
    case 'historical-source': {
      if (location.pathname.startsWith('/turnaround/precedent/')) { el = byId('turnaround-precedent-record'); mode = 'done'; break; }
      const evidence = panel('Historical precedent');
      el = evidence ? all('a[href]', evidence).find(item =>
        new URL(item.getAttribute('href')!, location.href).pathname.startsWith('/turnaround/precedent/')) ?? null : null;
      if (el) { next.historicalReturn = location.pathname + location.search; mode = 'click'; }
      else if (evidence) { el = evidence; message = 'No exact historical source match is available for this job. No substitute evidence was selected.'; }
      break;
    }
    case 'historical-back': throw new Error('Historical return must be validated by the desktop runner.');
    case 'full-job':
      if (pair.jobPath && location.pathname === pair.jobPath) { el = byId('turnaround-item'); mode = 'done'; }
      else { el = named('a[href]', 'Open full job record'); mode = 'click'; }
      break;
    case 'submission': el = heading('Submission'); break;
    case 'intake': clickUnless(tab('Intake findings'), tab('Intake findings')?.getAttribute('aria-selected') === 'true'); break;
    case 'job-details': el = byId('turnaround-job-details'); break;
    case 'tams-request': el = heading('TAMS-format request'); break;
    case 'equipment': {
      const target = tab('Equipment');
      if (target) clickUnless(target, target.getAttribute('aria-selected') === 'true');
      else el = all('table[aria-label="Equipment"]')[0]
        ?? named('dt', 'Equipment', byId('turnaround-job-details') ?? document)?.parentElement ?? null;
      break;
    }
    case 'floc': {
      const target = tab('FLOC');
      if (target) clickUnless(target, target.getAttribute('aria-selected') === 'true');
      else {
        const equipment = all('table[aria-label="Equipment"]')[0];
        el = equipment ? all('thead th', equipment).find(header => text(header).toLowerCase() === 'floc') ?? null : null;
      }
      break;
    }
    case 'decision-tab': clickUnless(tab('Decision'), tab('Decision')?.getAttribute('aria-selected') === 'true'); break;
    case 'human-reviews': el = heading('Human decisions'); break;
    case 'disposition': el = named('strong', 'Scope disposition'); break;
    case 'decision-history': {
      const item = summary('Decision history');
      if (item) clickUnless(item, item.closest('details')?.open === true);
      else { el = panel('Human decisions'); message = 'No decision history is recorded for this job. No approval was created.'; }
      break;
    }
    case 'final-jobs': el = document.getElementById('final-scope-jobs-heading'); break;
    case 'final-orders': el = document.getElementById('final-scope-orders-heading'); break;
    case 'final-unresolved':
      el = document.getElementById('final-scope-jobs-pending') ?? all('[aria-label="Job scope summary"]')[0] ?? null; break;
    case 'final-open-unresolved': {
      const retained = (pair.jobPath ? link(pair.jobPath)?.closest('tr') : null)
        ?? (orderPath ? link(orderPath)?.closest('tr') : null);
      el = retained ?? all('[aria-label="Job scope summary"]')[0] ?? null;
      message = retained
        ? 'The retained record stays in view; no different record was opened.'
        : 'The retained record is not shown here; no other record was opened.';
      break;
    }
    case 'final-record': {
      const retained = (pair.jobPath ? link(pair.jobPath)?.closest('tr') : null)
        ?? (orderPath ? link(orderPath)?.closest('tr') : null);
      el = retained ?? all('[aria-label="Job scope summary"]')[0] ?? null;
      if (!retained) message = 'The retained record is not shown here; no other record was selected.';
      break;
    }
    case 'planner-basis': el = heading('Historical evidence and planner-assumption scenario'); break;
    case 'planner-inputs': el = document.getElementById('historical-start'); break;
    case 'planner-jobs': el = document.getElementById('historical-parallel'); break;
    case 'planner-results':
      el = all('[aria-label="Planner scenario result"]')[0] ?? null;
      if (!el) { el = document.getElementById('historical-start'); message = 'No planner-assumption result is currently displayed. No values were entered and no calculation was run.'; }
      break;
    case 'planner-boundary': el = panel('Historical evidence and planner-assumption scenario'); break;
  }
  if (!visible(el)) return null;
  if (mode === 'point' && el.getBoundingClientRect().height > innerHeight / 2) {
    el = all('h2,h3,h4', el)[0] ?? el;
  }
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const x = Math.round(Math.max(8, Math.min(innerWidth - 8, rect.left + Math.min(rect.width / 2, 180))));
  const y = Math.round(Math.max(8, Math.min(innerHeight - 8, rect.top + Math.min(rect.height / 2, 80))));
  const hit = document.elementFromPoint(x, y);
  if ((mode === 'click' || mode === 'fill') && (!hit || (hit !== el && !el.contains(hit)))) return null;
  const key = `${step}:${el.tagName}:${el.getAttribute('href') ?? ''}:${el.id}:${text(el).slice(0, 120)}`;
  if (scroll) {
    let cursor = document.getElementById('athena-demo-cursor');
    if (!cursor) {
      cursor = document.createElement('div'); cursor.id = 'athena-demo-cursor';
      Object.assign(cursor.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
        width: '18px', height: '18px', border: '3px solid white', borderRadius: '50%',
        background: '#0f62fe', boxShadow: '0 0 0 3px #161616', transition: 'left 500ms ease, top 500ms ease' });
      document.body.appendChild(cursor);
    }
    cursor.style.left = `${x - 9}px`; cursor.style.top = `${y - 9}px`;
    let notice = document.getElementById('athena-demo-notice');
    if (message) {
      if (!notice) {
        notice = document.createElement('div'); notice.id = 'athena-demo-notice';
        notice.setAttribute('role', 'status');
        Object.assign(notice.style, { position: 'fixed', bottom: '16px', left: '16px', maxWidth: '560px',
          zIndex: '2147483646', background: '#262626', color: '#f4f4f4', border: '1px solid #525252',
          padding: '12px 16px', font: '14px Segoe UI, sans-serif', pointerEvents: 'none' });
        document.body.appendChild(notice);
      }
      notice.textContent = message;
    } else notice?.remove();
  }
  const href = mode === 'click' ? el.closest<HTMLAnchorElement>('a[href]')?.href : undefined;
  const url = href ? new URL(href, location.href) : null;
  if (url && (url.origin !== location.origin || !url.pathname.startsWith('/turnaround/'))) throw new Error('The inspection link is outside the approved Turnaround application.');
  return { x, y, mode, key, pair: next, ...(message ? { message } : {}), ...(value !== undefined ? { value } : {}),
    ...(url ? { destination: url.pathname + url.search } : {}) };
}
