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
export type ScriptDemo = PilotScriptDemo | ScriptNavigationDemo;

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
