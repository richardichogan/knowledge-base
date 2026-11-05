import css from '../../athena-desktop/assets/visuals.css?raw';
import { createVisualRenderer, visualBuildSteps, VISUAL_BUILD_INTERVAL_MS } from '../../athena-desktop/assets/visuals.js';
import { parseScriptVisuals, type ScriptVisualScene } from '../../knowledge-hub-backend/src/utils/scriptVisuals';

const cue = { blockId: 'b1', quote: '' };
const items = (...labels: string[]) => labels.map(label => ({ label, detail: '', cue }));
const base = { cue, imageUrl: '', imageAlt: '', subtitle: '' };
type Raw = Record<string, unknown>;
const text = (id: string, x: number, y: number, width: number, height: number, label: string, tone: string, reveal: number, extra: Raw = {}) =>
  ({ id, kind: 'text', x, y, width, height, label, detail: '', tone, icon: '', reveal, ...extra });
const link = (from: string, to: string, tone: string, reveal: number, extra: Raw = {}) =>
  ({ from, to, label: '', tone, reveal, style: 'solid', motion: 'draw', ...extra });

const fixture = parseScriptVisuals({ version: 1, source: 'harness', scenes: [
  { ...base, id: 'title', template: 'title', title: 'Digital workers you can hold to account',
    subtitle: 'Why Imagine Enterprise moves AI from personal experiments into accountable, evidenced work.',
    items: [], composition: { label: 'Why Imagine Enterprise', imagePrompt: '', nodes: [], links: [] } },
  { ...base, id: 'gap', template: 'concept', title: 'AI pilots stall between the demo and the work',
    subtitle: 'Copilots help individuals. Nobody owns the outcome.', items: items('Today', 'The gap', 'The goal'),
    composition: { label: 'The problem', imagePrompt: '', links: [
      link('today', 'gap', 'neutral', 2), link('gap', 'goal', 'warning', 3, { style: 'dashed' }),
    ], nodes: [
      { id: 'today', kind: 'panel', x: 80, y: 392, width: 400, height: 256, kicker: 'Today', label: 'Copilots help individuals',
        detail: 'Faster drafts, emails and searches, one person at a time.', tone: 'purple', icon: 'person', reveal: 1 },
      { id: 'gap', kind: 'panel', x: 600, y: 392, width: 400, height: 256, kicker: 'The gap', label: 'No one owns the work',
        detail: 'Hand-offs, approvals and evidence fall between tools.', tone: 'warning', icon: 'document', reveal: 2 },
      { id: 'goal', kind: 'panel', x: 1120, y: 392, width: 400, height: 256, kicker: 'The goal', label: 'Accountable outcomes',
        detail: 'Work completed end to end, with controls and an audit trail.', tone: 'success', icon: 'check', reveal: 3 },
    ] } },
  { ...base, id: 'loop', template: 'steps', title: 'Every piece of work runs one accountable loop',
    items: items('Request', 'Plan', 'Deliver', 'Verify'),
    composition: { label: 'How work runs', imagePrompt: '', nodes: [
      text('hub', 640, 480, 320, 80, 'Digital worker', 'blue', 1),
      text('request', 660, 245, 280, 70, 'Request', 'purple', 1, { size: 's' }),
      text('plan', 1060, 485, 280, 70, 'Plan', 'blue', 2, { size: 's' }),
      text('deliver', 660, 725, 280, 70, 'Deliver', 'teal', 3, { size: 's' }),
      text('verify', 260, 485, 280, 70, 'Verify', 'success', 4, { size: 's' }),
    ], links: [
      link('request', 'plan', 'blue', 2, { route: 'arc' }), link('plan', 'deliver', 'blue', 3, { route: 'arc' }),
      link('deliver', 'verify', 'blue', 4, { route: 'arc' }), link('verify', 'request', 'blue', 4, { route: 'arc' }),
    ] } },
  { ...base, id: 'handoff', template: 'steps', title: 'People set intent; digital workers carry it through',
    subtitle: 'Specialist agents do the expert steps, and every step is evidenced.',
    items: items('People', 'Digital worker', 'Specialist agents', 'Accountable result'),
    composition: { label: 'Who does what', imagePrompt: '', nodes: [
      { id: 'people', kind: 'icon', x: 80, y: 384, width: 288, height: 224, label: 'People', detail: 'Set intent and approve', tone: 'purple', icon: 'person', reveal: 1 },
      { id: 'worker', kind: 'icon', x: 464, y: 384, width: 288, height: 224, label: 'Digital worker', detail: 'Owns the outcome', tone: 'blue', icon: 'worker', reveal: 2 },
      { id: 'agents', kind: 'icon', x: 848, y: 384, width: 288, height: 224, label: 'Specialist agents', detail: 'Do the expert steps', tone: 'teal', icon: 'system', reveal: 3 },
      { id: 'result', kind: 'icon', x: 1232, y: 384, width: 288, height: 224, label: 'Accountable result', detail: 'Evidenced and signed off', tone: 'success', icon: 'check', reveal: 4 },
    ], links: [
      link('people', 'worker', 'purple', 2, { motion: 'flow', label: 'intent' }),
      link('worker', 'agents', 'blue', 3, { motion: 'flow', label: 'tasks' }),
      link('agents', 'result', 'teal', 4, { motion: 'flow', label: 'evidence' }),
    ] } },
  { ...base, id: 'compare', template: 'comparison', title: 'From assistance to accountability',
    subtitle: 'The difference is who owns the outcome.', items: items('Copilot', 'Digital worker'),
    composition: { label: 'The distinction', imagePrompt: '', nodes: [
      text('assist', 160, 424, 560, 192, 'Assists', 'neutral', 1, { size: 'l', kicker: 'Copilot', detail: 'One person, when asked, inside one app.' }),
      text('own', 880, 424, 560, 192, 'Owns', 'blue', 2, { size: 'l', kicker: 'Digital worker', detail: 'A whole process, from request to signed-off result.' }),
    ], links: [link('assist', 'own', 'blue', 2)] } },
  { ...base, id: 'result', template: 'statistic', title: 'What changes for the business', presenterLayout: true,
    items: items('Owned', 'Evidenced', 'Approved'),
    composition: { label: 'The result', imagePrompt: '', links: [], nodes: [
      text('owned', 80, 320, 1200, 80, 'Owned end to end.', 'blue', 1, { size: 'l' }),
      text('evidenced', 80, 440, 1200, 80, 'Evidenced at every step.', 'success', 2, { size: 'l' }),
      text('approved', 80, 560, 1200, 80, 'Approved by people.', 'purple', 3, { size: 'l' }),
    ] } },
] });

// ?job=<agent job id> previews a saved Ariadne result instead of the fixtures; nothing is applied.
const jobId = new URLSearchParams(location.search).get('job');
const loadJob = async (id: string) => {
  const response = await fetch(`/api/agent-jobs/${encodeURIComponent(id)}`, { credentials: 'include' });
  const body = await response.json() as { data?: { result?: { sections?: { visuals?: unknown }[] } } };
  const scenes = (body.data?.result?.sections ?? []).flatMap(section => parseScriptVisuals(section.visuals).scenes);
  return { ...fixture, source: id, scenes };
};
const plan = jobId ? await loadJob(jobId) : fixture;

const root = document.getElementById('root')!;
const tools = document.createElement('div');
tools.className = 'harness__tools';
const host = document.createElement('div');
host.className = 'harness__stage';
const note = document.createElement('p');
note.className = 'harness__note';
note.textContent = jobId ? `Saved Ariadne result ${jobId}. Preview only; nothing here is applied or saved.`
  : 'Isolated renderer preview with fixture content. Nothing here is saved or sent to Ariadne.';
root.append(tools, host, note);

const shadow = host.attachShadow({ mode: 'open' });
const styles = document.createElement('style');
styles.textContent = css.replaceAll('100vh', '100cqh').replaceAll('position: fixed', 'position: absolute');
const visualRoot = document.createElement('div');
visualRoot.className = 'visual-root';
const stage = document.createElement('main');
stage.setAttribute('aria-label', 'Presentation visual');
const status = document.createElement('p');
status.id = 'status';
status.setAttribute('role', 'status');
status.hidden = true;
visualRoot.append(stage, status);
shadow.replaceChildren(styles, visualRoot);
const render = createVisualRenderer(stage, status, visualRoot);

const video = { mode: 'guide' as const, status: 'idle' as const, error: null, requestId: '' };
let current = 0;
let presenterOverride: boolean | null = null;
let timer = 0;
const sceneButtons: HTMLButtonElement[] = [];
const scene = (index: number): ScriptVisualScene => {
  const value = plan.scenes[index]!;
  return presenterOverride === null ? value : { ...value, presenterLayout: presenterOverride };
};
const show = (index: number, revealed: number, animate: boolean) => {
  current = index;
  sceneButtons.forEach((button, at) => { button.setAttribute('aria-pressed', String(at === index)); });
  render({ scene: scene(index), revealed, error: null, presentationTitle: 'Why Imagine Enterprise',
    page: index + 1, total: plan.scenes.length, video, animate });
};
const stop = () => { window.clearTimeout(timer); };
const build = (index: number, then?: () => void) => {
  stop();
  const steps = visualBuildSteps(plan.scenes[index]!.items);
  let step = 0;
  const next = () => {
    show(index, steps[step]!, true);
    step++;
    timer = window.setTimeout(step < steps.length ? next : () => then?.(), step < steps.length ? VISUAL_BUILD_INTERVAL_MS : 2600);
  };
  next();
};
const button = (label: string, action: () => void) => {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', action);
  tools.append(element);
  return element;
};

const heading = document.createElement('p');
heading.textContent = 'Scenes';
tools.append(heading);
plan.scenes.forEach((value, index) => {
  sceneButtons.push(button(`${index + 1} ${value.composition?.label ?? value.title}`, () => { stop(); show(index, value.items.length, true); }));
});
button('Play scene build', () => { build(current); });
button('Play whole deck', () => {
  const run = (index: number) => { build(index, () => { if (index + 1 < plan.scenes.length) run(index + 1); }); };
  run(0);
});
const presenter = button('Presenter layout: as authored', () => {
  presenterOverride = presenterOverride === null ? true : presenterOverride ? false : null;
  presenter.textContent = `Presenter layout: ${presenterOverride === null ? 'as authored' : presenterOverride ? 'on' : 'off'}`;
  stop();
  show(current, plan.scenes[current]!.items.length, false);
});

show(0, plan.scenes[0]!.items.length, false);
