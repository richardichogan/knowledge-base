import type { DemoStep } from './demoSteps';

export interface WorkforceTarget {
  el: HTMLElement | null;
  mode?: 'point' | 'click' | 'fill';
  value?: string;
  message?: string;
}

// Injected into the demo page; only named local UI controls are actionable.
export function locateWorkforceElement(step: DemoStep): WorkforceTarget {
  const profile = location.pathname === '/agents/agent_turnaround_challenge';
  const workforce = location.pathname === '/agents' && new URLSearchParams(location.search).get('workforce') === 'wf_turnaround';
  if (!profile && !workforce) throw new Error('The workforce demo left its selected workforce or specialist.');
  const visible = (el: Element): el is HTMLElement => el instanceof HTMLElement
    && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const all = (selector: string, root: ParentNode = document): HTMLElement[] => Array.from(root.querySelectorAll(selector)).filter(visible);
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const named = (selector: string, name: string, root: ParentNode = document): HTMLElement | null =>
    all(selector, root).find(el => text(el) === name || el.getAttribute('aria-label') === name) ?? null;
  const byId = (id: string): HTMLElement | null => all(`[data-demo-id="${id}"]`)[0] ?? null;
  const heading = (name: string, root: ParentNode = document): HTMLElement | null => named('h2,h3,h4,h5,h6,strong', name, root);
  const click = (el: HTMLElement | null, done = false): WorkforceTarget => ({ el, mode: done ? 'point' : 'click' });
  const tab = (name: string, group: string): WorkforceTarget => {
    const root = all('[role="tablist"]').find(el => el.getAttribute('aria-label') === group);
    const el = root ? named('[role="tab"]', name, root) : null;
    return click(el, el?.getAttribute('aria-selected') === 'true');
  };
  const fill = (el: HTMLElement | null, value: string): WorkforceTarget => {
    if (el && (!(el instanceof HTMLInputElement) || !['search', 'text'].includes(el.type))) {
      throw new Error('The workforce search control changed. Nothing was typed.');
    }
    return { el, mode: (el as HTMLInputElement | null)?.value === value ? 'point' : 'fill', value };
  };
  const panels = all('[role="tabpanel"]');
  const activePanel = panels[panels.length - 1] ?? null;
  const workforceTitle = all('.workforce-summary h3')[0];
  const memberHeader = byId('member-header') ?? named('h1', 'Scope Challenge Specialist');
  if (workforce && !workforceTitle || profile && !memberHeader) return { el: null };
  if (workforce && workforceTitle && !/Turnaround.*Workforce/.test(text(workforceTitle))) {
    throw new Error('The selected Turnaround workforce is not loaded. No other workforce was substituted.');
  }
  if (profile && memberHeader && !memberHeader.textContent?.includes('Scope Challenge Specialist')) {
    throw new Error('The Scope Challenge Specialist is not loaded. No other participant was substituted.');
  }
  const workforceTabs: Partial<Record<DemoStep, string>> = {
    'workforce-composition': 'Composition & Flow', 'workforce-dependencies': 'Dependency Map & Relationships',
    'workforce-explorer': 'Workforce Explorer', 'workforce-coverage': 'Coverage Analysis',
    'workforce-maturity': 'Maturity Assessment', 'workforce-context': 'Context Intelligence', 'workforce-bom': 'Bill of Materials',
  };
  const mainTabs: Partial<Record<DemoStep, string>> = {
    'workforce-profile-overview': 'Overview', 'workforce-orchestration': 'Orchestration', 'workforce-io': 'Inputs & Outputs',
    'workforce-governance': 'Governance', 'workforce-prompt': 'Foundry Prompt', 'workforce-specification': 'Specification',
    'workforce-tools': 'Tools', 'workforce-evals': 'Evals', 'workforce-testing': 'Testing', 'workforce-chat': 'Test Chat',
    'workforce-observability': 'Observability',
  };
  const overviewTabs: Partial<Record<DemoStep, string>> = {
    'workforce-role': 'Responsibilities & role', 'workforce-authority': 'Authority & escalation',
    'workforce-employment': 'Employment & deployment', 'workforce-systems': 'Systems & technology',
    'workforce-relationships': 'Context & relationships',
  };
  const workforceTab = workforceTabs[step], mainTab = mainTabs[step], overviewTab = overviewTabs[step];
  if (workforceTab) return tab(workforceTab, 'Workforce Intelligence tabs');
  if (mainTab) return tab(mainTab, 'Agent details tabs');
  if (overviewTab) return tab(overviewTab, 'Overview sections');
  const ids: Partial<Record<DemoStep, string>> = {
    'workforce-maturity-level': 'workforce-maturity-level',
    'workforce-maturity-actions': 'workforce-maturity-actions', 'workforce-context-flow': 'workforce-context-flow',
    'workforce-bom-assets': 'workforce-bom-assets',
  };
  const id = ids[step];
  if (id) return { el: byId(id) };
  const dialog = all('[role="dialog"]').find(el => text(el).includes('Stage handoff')) ?? null;
  switch (step) {
    case 'workforce-summary': return { el: all('.workforce-summary')[0] ?? null };
    case 'workforce-catalog-views': {
      const el = byId('catalog-views');
      const workforces = el && all('button,[role="tab"]', el).find(tab => text(tab) === 'Workforces');
      if (workforces && ![workforces.getAttribute('aria-selected'), workforces.getAttribute('aria-pressed'),
        workforces.getAttribute('data-state')].includes('true') && !workforces.classList.contains('cds--content-switcher--selected')) {
        throw new Error('Workforces is not the selected catalogue view.');
      }
      return { el };
    }
    case 'workforce-steward': return { el: all('.wf-coordinator').find(el => text(el).includes('Turnaround Planning Digital Steward')) ?? null };
    case 'workforce-stage-overview': {
      const el = named('button', 'Stage overview');
      return click(el, el?.getAttribute('aria-selected') === 'true');
    }
    case 'workforce-stages': return { el: all('.wf-card h4').find(el => text(el).includes('Scope Challenge')) ?? null };
    case 'workforce-handoff':
      if (dialog) return { el: dialog };
      return click(all('button[aria-label]').find(el =>
        el.getAttribute('aria-label')?.startsWith('Explain handoff from Scope Challenge Digital Worker to Interval Scenario Digital Worker')) ?? null);
    case 'workforce-handoff-path': return { el: dialog && heading('Digital Steward \u2192 Digital Worker handoff path', dialog) };
    case 'workforce-handoff-package': return { el: dialog && heading('Package passed', dialog) };
    case 'workforce-handoff-criteria': return { el: dialog && heading('Transfer and acceptance criteria', dialog) };
    case 'workforce-handoff-close':
      return dialog ? click(all('button[aria-label="Close"]', dialog)[0] ?? null) : { el: byId('workforce-flow') };
    case 'workforce-assets': {
      const el = named('summary', 'Show recorded assets by category');
      return click(el, el?.closest('details')?.open === true);
    }
    case 'workforce-routing': return { el: heading('Routing & gates') };
    case 'workforce-dependency-search': return fill(all('#wfi-participant-search')[0] ?? null, 'Scope Challenge Specialist');
    case 'workforce-dependency-select': {
      const selected = all('#wfi-inspector-title').some(el => text(el) === 'Scope Challenge Specialist');
      return selected ? { el: all('#wfi-inspector-title')[0] ?? null }
        : click(all('#wfi-search-results button').find(el => text(el).startsWith('Scope Challenge Specialist')) ?? null);
    }
    case 'workforce-dependency-focus': {
      const el = named('button', 'Focus on connections', all('.wfi-map-inspector')[0] ?? document);
      return click(el, el instanceof HTMLButtonElement && el.disabled);
    }
    case 'workforce-dependency-details': return { el: heading('Member relationships and dependencies') };
    case 'workforce-explorer-search': {
      const root = all('.wfi-org-chart')[0];
      if (root && all('select', root).some(el => (el as HTMLSelectElement).value !== 'all')) {
        throw new Error('Use All types and All statuses in Workforce Explorer before this walkthrough.');
      }
      return fill(root ? all('input[type="search"]', root)[0] ?? null : null, 'Scope Challenge Specialist');
    }
    case 'workforce-explorer-select': {
      const el = all('[role="treeitem"]').find(el => el.getAttribute('aria-label')?.startsWith('Scope Challenge Specialist,')) ?? null;
      return click(el, el?.getAttribute('aria-selected') === 'true');
    }
    case 'workforce-explorer-details': return { el: all('.wfi-org-inspector')[0] ?? null };
    case 'workforce-coverage-detail': return { el: all('.wfi-coverage-row').find(el => text(el).includes('Scope Challenge')) ?? null };
    case 'workforce-context-prior':
    case 'workforce-context-long-lead': {
      const label = step === 'workforce-context-prior' ? 'Prior outcomes' : 'Long-lead register';
      const el = all('.wfi-context-source').find(el =>
        el.querySelector('strong')?.textContent?.toLowerCase().includes(label.toLowerCase())) ?? null;
      return { el: el ?? activePanel, ...(!el ? { message: `${label} is not recorded here. No source was invented.` } : {}) };
    }
    case 'workforce-bom-clear':
    case 'workforce-profile-search': {
      const container = byId('workforce-bom-search');
      const input = container instanceof HTMLInputElement ? container : container?.querySelector<HTMLElement>('input') ?? null;
      return fill(input, step === 'workforce-bom-clear' ? '' : 'Scope Challenge');
    }
    case 'workforce-profile-open':
      if (profile) return { el: memberHeader };
      return click(named('button', 'Scope Challenge Specialist', byId('workforce-bom-assets') ?? document));
    case 'workforce-profile-controls': return { el: memberHeader };
    case 'workforce-profile-edit':
    case 'workforce-profile-spec':
    case 'workforce-profile-lifecycle': {
      const labels: Record<string, string[]> = {
        'workforce-profile-edit': ['Edit Agent'],
        'workforce-profile-spec': ['Generate Spec'],
        'workforce-profile-lifecycle': ['Recruit', 'Update'],
      };
      const button = memberHeader ? all('button', memberHeader).find(el => labels[step]?.includes(text(el))) ?? null : null;
      if (!button) return { el: memberHeader };
      const state = button instanceof HTMLButtonElement && button.disabled;
      return { el: button, ...(state ? { message: `${text(button)} is disabled: ${button.title || 'the current permission or lifecycle state does not allow this action'}. No management action was taken.` }
        : { message: `${text(button)} is available to an authorised user. No management action was taken.` }) };
    }
    case 'workforce-configuration-open': {
      const section = all('#agent-configuration-assistant')[0] ?? null;
      const openButton = named('button', 'Open configuration assistant');
      const closeButton = named('button', 'Close configuration assistant', section ?? document);
      if (section) return { el: closeButton ?? section };
      if (!openButton) return { el: memberHeader, message: 'Configuration assistant control is unavailable on this profile.' };
      if (openButton instanceof HTMLButtonElement && openButton.disabled) {
        return { el: openButton, message: `Configuration assistant is disabled: ${openButton.title || 'the current permission or lifecycle state does not allow it'}. No request was made.` };
      }
      return click(openButton);
    }
    case 'workforce-configuration-intro': {
      const section = all('#agent-configuration-assistant')[0] ?? null;
      if (!section) {
        const button = named('button', 'Open configuration assistant');
        return button && button instanceof HTMLButtonElement && button.disabled
          ? { el: button, message: `Configuration assistant is disabled: ${button.title || 'the current permission or lifecycle state does not allow it'}. No request was made.` }
          : { el: null };
      }
      const input = all('#configure-chat-input', section)[0];
      if (!(input instanceof HTMLInputElement)) throw new Error('The configuration request field changed. No request was sent.');
      if (input.value.trim()) throw new Error('The configuration request field is not empty. No request was sent.');
      const intro = all('.configure-chat__messages', section)[0];
      if (!intro || !text(intro).includes('I can configure')) throw new Error('The configuration assistant introduction did not load. No request was sent.');
      return { el: input };
    }
    case 'workforce-configuration-close': {
      const section = all('#agent-configuration-assistant')[0] ?? null;
      if (!section) return { el: activePanel ?? memberHeader };
      const button = named('button', 'Close configuration assistant', section);
      return click(button);
    }
    case 'workforce-inputs': return tab('Inputs', 'Input and output property sections');
    case 'workforce-outputs': return tab('Outputs', 'Input and output property sections');
    case 'workforce-governance-profile': return tab('Governance profile', 'Governance property sections');
    case 'workforce-governed-execution': return tab('Governed execution', 'Governance property sections');
    case 'workforce-profile-content':
    case 'workforce-role-handoffs':
    case 'workforce-escalation':
    case 'workforce-deployment':
    case 'workforce-contract-fields':
    case 'workforce-tool-date':
    case 'workforce-tool-precedent':
    case 'workforce-tool-configured':
    case 'workforce-eval-mandatory':
    case 'workforce-eval-case':
    case 'workforce-execution-evidence': {
      if (!profile || !activePanel) return { el: null };
      if (all('.cds--loading,[aria-busy="true"]', activePanel).length
        || /loading (execution history|prompt|specification|eval|test)/i.test(text(activePanel))) return { el: null };
      const error = all('.cds--inline-notification--error', activePanel)[0];
      if (error) throw new Error(`The specialist content could not be loaded: ${text(error)}`);
      const headings: Partial<Record<DemoStep, string>> = {
        'workforce-role-handoffs': 'Role & handoffs', 'workforce-escalation': 'Escalation criteria',
        'workforce-deployment': 'Deployment', 'workforce-contract-fields': 'Recorded fields & format',
      };
      const label = headings[step];
      if (label) return { el: heading(label, activePanel) };
      if (step === 'workforce-tool-date' || step === 'workforce-tool-precedent') {
        const name = step === 'workforce-tool-date' ? 'compute_turnaround_date_position' : 'search_tams_precedent';
        const el = named('strong', name, activePanel);
        return { el: el ?? activePanel, ...(!el ? { message: `${name} is not listed as a configured callable function. No tool was changed or called.` } : {}) };
      }
      if (step === 'workforce-tool-configured') {
        const tool = all('.info-tile strong', activePanel).find(el =>
          el.parentElement?.querySelector('.cds--tag')) ?? null;
        const target = tool?.parentElement?.parentElement?.parentElement ?? null;
        return { el: target ?? activePanel, ...(!tool ? { message: text(activePanel).includes('No tools configured yet')
          ? 'No callable tools are configured for this agent. No tool was changed or called.'
          : 'No configured callable tool is displayed. Designed interfaces are not configured calls.' } : {}) };
      }
      if (step === 'workforce-eval-mandatory' || step === 'workforce-eval-case') {
        if (all('.cds--loading,[aria-busy="true"]', activePanel).length) return { el: null };
        const cases = all('.info-tile strong', activePanel);
        const selected = step === 'workforce-eval-mandatory'
          ? cases.find(el => text(el).includes('SI-003')) ?? null : cases[0] ?? null;
        if (selected) return { el: selected.parentElement?.parentElement?.parentElement ?? selected };
        return { el: activePanel, message: text(activePanel).includes('No eval cases yet')
          ? 'No evaluation cases are recorded. No case was created or run.'
          : 'Evaluation cases are unavailable here. No case was created or run.' };
      }
      if (step === 'workforce-execution-evidence') {
        const el = named('summary', 'View execution evidence', activePanel);
        return el ? click(el, el.closest('details')?.open === true)
          : { el: activePanel, message: 'No execution evidence row is displayed. No execution was triggered.' };
      }
      return { el: all('.tab-content,.info-tile', activePanel)[0] ?? activePanel };
    }
    case 'workforce-back':
      return workforce ? { el: all('.workforce-summary')[0] ?? null }
        : click(named('button', 'Back') ?? all('button[aria-label="Back"]')[0] ?? null);
    default: throw new Error('Unknown workforce inspection target.');
  }
}
