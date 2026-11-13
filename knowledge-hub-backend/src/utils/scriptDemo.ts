import { scriptVisualSource, visualCueResolver, visualSourceBlocks, visualSourceCurrent, type VisualCue, type VisualScriptBlock } from './scriptVisuals.js';

export const TURNAROUND_ACTIONS = ['scope-list', 'jobs', 'first-job'] as const;
export type TurnaroundAction = typeof TURNAROUND_ACTIONS[number];
export const TURNAROUND_ROUTES = {
  overview: { label: 'Overview', path: '/turnaround/overview' },
  plan: { label: 'Plan & work orders', path: '/turnaround/plan' },
  scopeList: { label: 'Scope list → Work orders', path: '/turnaround/queue?view=work-orders' },
  challenge: { label: 'Scope challenge', path: '/turnaround/challenge' },
  finalScope: { label: 'Final scope', path: '/turnaround/final-scope' },
  scenarioPlanner: { label: 'Turnaround Scenario Planner', path: '/turnaround/twin' },
  productionImpact: { label: 'Production impact', path: '/turnaround/production-impact' },
  gate: { label: 'Job freeze', path: '/turnaround/gate' },
  audit: { label: 'Decision trace', path: '/turnaround/audit' },
  workforce: { label: 'Workforce Intelligence: Turnaround', path: '/agents?workforce=wf_turnaround' },
} as const;
export type TurnaroundRoute = keyof typeof TURNAROUND_ROUTES;

export interface PilotScriptDemo {
  version: 1;
  source: string;
  actions: Array<{ action: TurnaroundAction; cue: VisualCue }>;
}
export interface ScriptNavigationDemo {
  version: 2;
  source: string;
  actions: Array<{ action: 'navigate'; route: TurnaroundRoute; cue: VisualCue }>;
}
export const SCRIPT_DEMO_STEPS = [
  'event', 'standing', 'funnel', 'waiting', 'activity', 'lifecycle', 'steward',
  'plan-expand', 'plan-job-expand', 'plan-orders', 'order-open', 'order-sap',
  'order-evidence-open', 'order-evidence', 'order-related',
  'proposal-expand', 'proposal-source', 'proposal-history',
  'scope-work-orders', 'scope-filter', 'clear-filters', 'waiting-tooltip',
  'order-challenge', 'challenge-order-evidence', 'challenge-job', 'challenge-workbench',
  'historical', 'historical-source', 'historical-back', 'full-job', 'submission', 'intake', 'job-details', 'tams-request', 'equipment', 'floc',
  'decision-tab', 'human-reviews', 'disposition', 'decision-history',
  'final-jobs', 'final-orders', 'final-unresolved', 'final-open-unresolved', 'final-record',
  'planner-basis', 'planner-inputs', 'planner-jobs', 'planner-results', 'planner-boundary',
  'workforce-summary', 'workforce-composition', 'workforce-stage-overview', 'workforce-steward', 'workforce-stages',
  'workforce-handoff', 'workforce-handoff-path', 'workforce-handoff-package', 'workforce-handoff-criteria', 'workforce-handoff-close',
  'workforce-assets', 'workforce-routing', 'workforce-dependencies', 'workforce-dependency-search', 'workforce-dependency-select',
  'workforce-dependency-focus', 'workforce-dependency-details', 'workforce-explorer', 'workforce-explorer-search',
  'workforce-explorer-select', 'workforce-explorer-details', 'workforce-coverage', 'workforce-coverage-detail',
  'workforce-maturity', 'workforce-maturity-level', 'workforce-maturity-actions', 'workforce-context', 'workforce-context-flow',
  'workforce-context-prior', 'workforce-context-long-lead', 'workforce-bom', 'workforce-bom-clear', 'workforce-bom-assets',
  'workforce-profile-search', 'workforce-profile-open', 'workforce-profile-overview', 'workforce-role', 'workforce-authority',
  'workforce-employment', 'workforce-systems', 'workforce-relationships', 'workforce-orchestration', 'workforce-io',
  'workforce-inputs', 'workforce-outputs', 'workforce-governance', 'workforce-governance-profile', 'workforce-governed-execution',
  'workforce-prompt', 'workforce-specification', 'workforce-tools', 'workforce-evals', 'workforce-testing', 'workforce-chat',
  'workforce-observability', 'workforce-execution-evidence', 'workforce-profile-content', 'workforce-back',
  'workforce-role-handoffs', 'workforce-escalation', 'workforce-deployment', 'workforce-contract-fields',
  'workforce-tool-date', 'workforce-tool-precedent', 'workforce-eval-mandatory',
  'workforce-catalog-views', 'workforce-profile-controls', 'workforce-profile-edit', 'workforce-profile-spec',
  'workforce-profile-lifecycle', 'workforce-configuration-open', 'workforce-configuration-intro',
  'workforce-configuration-close', 'workforce-tool-configured', 'workforce-eval-case',
] as const;
export type ScriptDemoStep = typeof SCRIPT_DEMO_STEPS[number];
export interface ScriptWalkthroughDemo {
  version: 3;
  source: string;
  actions: Array<
    { action: 'navigate'; route: TurnaroundRoute; cue: VisualCue }
    | { action: 'inspect'; target: ScriptDemoStep; cue: VisualCue; selection?: { jobId: string; workOrderId: string } }
  >;
}
export type ScriptDemo = PilotScriptDemo | ScriptNavigationDemo | ScriptWalkthroughDemo;

export function scriptWalkthroughFromPhrases(section: VisualScriptBlock, actions: unknown): ScriptWalkthroughDemo {
  if (!Array.isArray(actions)) throw new Error('Provide the ordered walkthrough actions.');
  return parseScriptDemo({ version: 3, source: scriptVisualSource(section),
    actions: actions.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid walkthrough action.');
      const entry = item as Record<string, unknown>;
      return { action: entry.action, ...(entry.action === 'navigate' ? { route: entry.route } : { target: entry.target, selection: entry.selection }),
        cue: spokenCue(section, entry.phrase as string) };
    }) }, section) as ScriptWalkthroughDemo;
}

function spokenCue(section: VisualScriptBlock, phrase: string): VisualCue {
  if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > 300) {
    throw new Error('Each demo cue needs a phrase of at most 300 characters.');
  }
  const blocks = visualSourceBlocks(section);
  const matching = blocks.filter(block => block.text.includes(phrase));
  if (matching.length !== 1 || matching[0]!.text.indexOf(phrase) !== matching[0]!.text.lastIndexOf(phrase)) {
    throw new Error(`The phrase "${phrase}" must appear exactly once in one spoken block.`);
  }
  return { blockId: matching[0]!.id, quote: phrase };
}

export function scriptDemoFromPhrases(section: VisualScriptBlock, phrases: string[]): ScriptDemo {
  if (phrases.length !== TURNAROUND_ACTIONS.length) throw new Error('Provide one phrase for each Turnaround action.');
  const actions = TURNAROUND_ACTIONS.map((action, index) => {
    return { action, cue: spokenCue(section, phrases[index] ?? '') };
  });
  return parseScriptDemo({ version: 1, source: scriptVisualSource(section), actions }, section);
}

export function scriptNavigationFromPhrase(section: VisualScriptBlock, route: TurnaroundRoute, phrase: string): ScriptNavigationDemo {
  if (!Object.prototype.hasOwnProperty.call(TURNAROUND_ROUTES, route)) throw new Error('Choose an approved Turnaround screen.');
  return parseScriptDemo({
    version: 2, source: scriptVisualSource(section),
    actions: [{ action: 'navigate', route, cue: spokenCue(section, phrase) }],
  }, section) as ScriptNavigationDemo;
}

export function parseScriptDemo(value: unknown, section?: VisualScriptBlock): ScriptDemo {
  const raw: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid demo cues.');
  const data = raw as Record<string, unknown>;
  if (typeof data.source !== 'string' || data.source.length > 500_000 || !Array.isArray(data.actions)) {
    throw new Error('Invalid Turnaround demo plan.');
  }
  if (data.version === 3) {
    if (!data.actions.length || data.actions.length > 24) throw new Error('A section supports 1–24 walkthrough actions.');
    let previous = -1;
    const resolve = section && visualCueResolver(section);
    const actions = data.actions.map((item: unknown): ScriptWalkthroughDemo['actions'][number] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid walkthrough action.');
      const entry = item as Record<string, unknown>;
      if (!entry.cue || typeof entry.cue !== 'object' || Array.isArray(entry.cue)) throw new Error('Invalid walkthrough cue.');
      const cue = entry.cue as Record<string, unknown>;
      if (typeof cue.blockId !== 'string' || !cue.blockId || cue.blockId.length > 100
        || typeof cue.quote !== 'string' || !cue.quote.trim() || cue.quote.length > 300) throw new Error('Invalid walkthrough phrase.');
      const anchored = { blockId: cue.blockId, quote: cue.quote };
      if (resolve) {
        const location = resolve(anchored);
        if (!location) throw new Error(`The walkthrough phrase "${cue.quote}" no longer matches the script.`);
        const position = location.index * 1_000_000 + location.offset;
        if (position < previous) throw new Error('Walkthrough actions must follow narration order.');
        previous = position;
      }
      if (entry.action === 'navigate' && typeof entry.route === 'string'
        && Object.prototype.hasOwnProperty.call(TURNAROUND_ROUTES, entry.route)) {
        return { action: 'navigate', route: entry.route as TurnaroundRoute, cue: anchored };
      }
      if (entry.action === 'inspect' && typeof entry.target === 'string' && SCRIPT_DEMO_STEPS.some(step => step === entry.target)) {
        let selection: { jobId: string; workOrderId: string } | undefined;
        if (entry.selection !== undefined) {
          const value = entry.selection as Record<string, unknown> | null;
          if (entry.target !== 'plan-job-expand' || !value || Array.isArray(value)
            || typeof value.jobId !== 'string' || !/^NPT2-TA-2027_[a-zA-Z0-9_-]{1,80}$/.test(value.jobId)
            || typeof value.workOrderId !== 'string' || !/^WO-[0-9]{1,12}$/.test(value.workOrderId)) {
            throw new Error('Choose an existing NPT2 job/work-order pair at the Plan job cue.');
          }
          selection = { jobId: value.jobId, workOrderId: value.workOrderId };
        }
        return { action: 'inspect', target: entry.target as ScriptDemoStep, cue: anchored, ...(selection ? { selection } : {}) };
      }
      throw new Error('Choose an approved read-only walkthrough action.');
    });
    if (section && !visualSourceCurrent(data.source, section)) throw new Error('The script changed. Review the walkthrough cues before presenting.');
    return { version: 3, source: data.source, actions };
  }
  if (data.version === 2) {
    if (data.actions.length !== 1) throw new Error('A section can navigate to one Turnaround screen.');
    const item = data.actions[0];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Turnaround navigation cue.');
    const entry = item as Record<string, unknown>;
    if (entry.action !== 'navigate' || typeof entry.route !== 'string'
      || !Object.prototype.hasOwnProperty.call(TURNAROUND_ROUTES, entry.route)
      || !entry.cue || typeof entry.cue !== 'object' || Array.isArray(entry.cue)) {
      throw new Error('Choose an approved Turnaround screen and spoken cue.');
    }
    const cue = entry.cue as Record<string, unknown>;
    if (typeof cue.blockId !== 'string' || !cue.blockId || cue.blockId.length > 100
      || typeof cue.quote !== 'string' || !cue.quote.trim() || cue.quote.length > 300) throw new Error('Invalid demo cue.');
    const action = { action: 'navigate' as const, route: entry.route as TurnaroundRoute,
      cue: { blockId: cue.blockId, quote: cue.quote } };
    if (section) {
      const location = visualCueResolver(section)(action.cue);
      if (!location) throw new Error(`The demo cue "${action.cue.quote}" no longer matches the script.`);
      if (!visualSourceCurrent(data.source, section)) throw new Error('The script changed. Review the navigation cue before presenting.');
    }
    return { version: 2, source: data.source, actions: [action] };
  }
  if (data.version !== 1 || data.actions.length !== TURNAROUND_ACTIONS.length) throw new Error('Invalid Turnaround demo plan.');
  let previous = -1;
  const resolve = section && visualCueResolver(section);
  const actions = data.actions.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid demo action.');
    const entry = item as Record<string, unknown>;
    if (entry.action !== TURNAROUND_ACTIONS[index] || !entry.cue || typeof entry.cue !== 'object' || Array.isArray(entry.cue)) {
      throw new Error('Turnaround actions must be in the approved order.');
    }
    const cue = entry.cue as Record<string, unknown>;
    if (typeof cue.blockId !== 'string' || !cue.blockId || cue.blockId.length > 100
      || typeof cue.quote !== 'string' || !cue.quote.trim() || cue.quote.length > 300) throw new Error('Invalid demo cue.');
    const result = { blockId: cue.blockId, quote: cue.quote };
    if (resolve) {
      const location = resolve(result);
      if (!location) throw new Error(`The demo cue "${result.quote}" no longer matches the script.`);
      const position = location.index * 1_000_000 + location.offset;
      if (position <= previous) throw new Error('Demo cues must follow the script in action order.');
      previous = position;
    }
    return { action: TURNAROUND_ACTIONS[index]!, cue: result };
  });
  if (section && !visualSourceCurrent(data.source, section)) throw new Error('The script changed. Review the demo phrases before presenting.');
  return { version: 1, source: data.source, actions };
}

export function readScriptDemo(section: VisualScriptBlock): ScriptDemo | null {
  const value = section.props?.scriptDemo;
  if (!value) return null;
  return parseScriptDemo(value);
}
