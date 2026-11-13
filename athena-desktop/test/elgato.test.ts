import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { ElgatoBridge } from '../src/elgatoBridge';
import { initialPresentation, parseCommand, parsePresentationRuns, parsePresentationVisuals, parseVisualVideoMode, playbackCommand, type PresentationDemoAction } from '../src/elgatoProtocol';
import type { VisualVideoState } from '../assets/visualComposition';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { VisualOutput } from '../src/visualOutput';
import { locateWorkforceElement } from '../src/workforceInspection';

test('configuration cues find the real panel id and protect an unfinished request', () => {
  class Element {
    constructor(public textContent = '', private readonly children: Record<string, Element[]> = {}) {}
    getClientRects(): number[] { return [1]; }
    getAttribute(): null { return null; }
    querySelectorAll(selector: string): Element[] { return this.children[selector] ?? []; }
  }
  class Input extends Element { value = ''; }
  class Button extends Element { disabled = false; }
  const header = new Element('Scope Challenge Specialist');
  const input = new Input();
  const intro = new Element('Hi! I can configure Scope Challenge Specialist.');
  const close = new Button('Close configuration assistant');
  const section = new Element('', { '#configure-chat-input': [input], '.configure-chat__messages': [intro], button: [close] });
  const document = new Element('', { '[data-demo-id="member-header"]': [header], '#agent-configuration-assistant': [section] });
  const context = createContext({
    document, location: { pathname: '/agents/agent_turnaround_challenge' },
    HTMLElement: Element, HTMLInputElement: Input, HTMLButtonElement: Button,
    getComputedStyle: () => ({ visibility: 'visible' }),
  });
  const locate = runInContext(`(${locateWorkforceElement.toString()})`, context) as typeof locateWorkforceElement;
  assert.equal(locate('workforce-configuration-open').el, close);
  assert.equal(locate('workforce-configuration-intro').el, input);
  assert.equal(locate('workforce-configuration-close').el, close);
  assert.equal(locate('workforce-configuration-close').mode, 'click');
  input.value = 'Unfinished request';
  assert.throws(() => locate('workforce-configuration-intro'), /not empty/);
});

test('resetting the demo replays its cues and cancels an in-flight cue', async () => {
  class Contents extends EventEmitter {
    url = '';
    moves = 0;
    inspections = 0;
    checkGate: Promise<void> | null = null;
    setWindowOpenHandler(): void {}
    getURL(): string { return this.url; }
    sendInputEvent(event: { type: string }): void { if (event.type === 'mouseMove') this.moves++; }
    async executeJavaScript(code: string): Promise<unknown> {
      if (code.startsWith('(() => {') && code.includes('workforce-summary h3')) return true;
      if (code.startsWith('(() => {') && code.includes('turnaround-overview')) return 'ready';
      this.inspections++;
      if (this.inspections === 2 && this.checkGate) await this.checkGate;
      return { x: 10, y: 10, key: 'target', mode: 'point', pair: {} };
    }
  }
  class Window extends EventEmitter {
    static instances: Window[] = [];
    webContents = new Contents();
    destroyed = false;
    constructor() { super(); Window.instances.push(this); }
    isDestroyed(): boolean { return this.destroyed; }
    getContentBounds(): { width: number; height: number } { return { width: 1200, height: 800 }; }
    async loadURL(url: string): Promise<void> { this.webContents.url = url; }
    show(): void {}
    close(): void { this.destroyed = true; this.emit('closed'); }
  }
  const realRequire = createRequire(join(__dirname, '../src/demoOutput.js'));
  const exported: { exports: unknown } = { exports: {} };
  const context = createContext({
    exports: exported.exports, module: exported, URL, setTimeout, clearTimeout,
    require: (name: string): unknown => name === 'electron'
      ? { BrowserWindow: Window, screen: {
        getAllDisplays: () => [{ id: 2, bounds: { x: 0, y: 0, width: 1200, height: 800 } }],
        getPrimaryDisplay: () => ({ id: 1 }),
      } }
      : realRequire(name),
  });
  runInContext(await readFile(join(__dirname, '../src/demoOutput.js'), 'utf8'), context);
  const { DemoOutput } = exported.exports as {
    DemoOutput: new (failed: (message: string) => void) => {
      open(displayId: number, prompterId: number | null, actions: PresentationDemoAction[]): Promise<void>;
      reset(prompterId: number | null): Promise<void>;
      update(position: number, playing: boolean): void;
      close(): void;
    };
  };
  const failures: string[] = [];
  const demo = new DemoOutput(message => { failures.push(message); });
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(condition(), 'Timed out waiting for the demo cue');
  };
  await demo.reset(3);
  assert.equal(Window.instances.length, 0);
  await demo.open(2, 3, [{ action: 'inspect', target: 'workforce-summary', at: 1 }]);
  const first = Window.instances.at(-1)!;
  assert.equal(first.webContents.url, 'http://localhost:5173/agents?workforce=wf_turnaround');
  demo.update(1, true);
  await waitFor(() => first.webContents.moves === 2);
  demo.update(1, false);
  await demo.reset(3);
  const second = Window.instances.at(-1)!;
  assert.equal(first.destroyed, true);
  assert.equal(second.webContents.url, first.webContents.url);
  assert.equal(second.webContents.moves, 0);
  let release!: () => void;
  second.webContents.checkGate = new Promise(resolve => { release = resolve; });
  demo.update(1, true);
  await waitFor(() => second.webContents.inspections === 2);
  demo.update(1, false);
  await demo.reset(3);
  const third = Window.instances.at(-1)!;
  release();
  demo.update(1, true);
  await waitFor(() => third.webContents.moves === 2);
  assert.equal(second.webContents.moves, 1);
  demo.close();
  await demo.open(2, 3, [{ action: 'inspect', target: 'event', at: 1 }]);
  const business = Window.instances.at(-1)!;
  assert.equal(business.webContents.url, 'http://localhost:5173/turnaround/overview');
  await demo.reset(3);
  assert.equal(Window.instances.at(-1)!.webContents.url, business.webContents.url);
  demo.close();
  assert.deepEqual(failures, []);
});

test('visual output validates bounded templates, finite positions and reveal ordering', () => {
  const scene = { id: 'one', template: 'concept', title: 'The idea', subtitle: '', imageUrl: '', imageAlt: '', at: 2,
    items: [{ label: 'Part', detail: '', at: 10 }] };
  assert.equal(parsePresentationVisuals([scene], 20)?.[0]?.items[0]?.at, 10);
  assert.throws(() => parsePresentationVisuals([{ ...scene, template: 'html' }], 20), /template/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, at: NaN }], 20), /cues/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, items: [{ label: 'Part', detail: '', at: 1 }] }], 20), /cues/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, imageUrl: 'file:///secret' }], 20), /image/);
  assert.throws(() => parsePresentationVisuals([scene], 5), /cues/);
  const artwork = { description: 'An authority boundary', shapes: [{ kind: 'circle', x: 1100, y: 450,
    width: 0, height: 0, radius: 200, d: '', tone: 'teal', opacity: 0.4 }] };
  assert.deepEqual(parsePresentationVisuals([{ ...scene, artwork, layout: 'hero' }], 20)?.[0]?.artwork, artwork);
  assert.throws(() => parsePresentationVisuals([{ ...scene, layout: 'html' }], 20), /layout/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, artwork: { ...artwork,
    shapes: [{ ...artwork.shapes[0], kind: 'path', d: 'url(secret)' }] } }], 20), /path/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, artwork: { ...artwork,
    shapes: [{ ...artwork.shapes[0], opacity: NaN }] } }], 20), /geometry/);
});

test('desktop validates composed nodes, geometry and connections at its independent trust boundary', () => {
  const node = { id: 'work', kind: 'panel', x: 100, y: 300, width: 320, height: 240,
    label: 'Work', detail: '', tone: 'teal', icon: 'worker', reveal: 0 };
  const composition = { label: '', imagePrompt: '', nodes: [node, { ...node, id: 'owner', x: 1000, reveal: 1 }],
    links: [{ from: 'work', to: 'owner', label: 'Exception', tone: 'warning', style: 'solid', reveal: 1 }] };
  const scene = { id: 'scene', template: 'concept', title: 'Human authority', subtitle: '', imageUrl: '', imageAlt: '', at: 0,
    items: [{ label: 'Exception', detail: '', at: 10 }], composition };
  assert.deepEqual(parsePresentationVisuals([scene], 20)?.[0]?.composition, composition);
  const animated = { ...scene, presenterLayout: true, composition: { ...composition,
    nodes: composition.nodes.map(node => ({ ...node, entrance: 'wipe', emphasis: 'underline' })),
    links: composition.links.map(link => ({ ...link, motion: 'flow', route: 'arc', fromPort: 'right', toPort: 'top' })),
  } };
  assert.deepEqual(parsePresentationVisuals([animated], 20)?.[0], animated);
  assert.throws(() => parsePresentationVisuals([{ ...animated, presenterLayout: 'true' }], 20), /presenter layout/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition,
    nodes: [{ ...node, entrance: 'execute' }],
  } }], 20), /entrance/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition,
    nodes: [{ ...node, emphasis: 'html' }],
  } }], 20), /emphasis/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition,
    links: [{ ...composition.links[0], motion: 'forever' }],
  } }], 20), /motion/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition,
    links: [{ ...composition.links[0], route: 'url(secret)' }],
  } }], 20), /route/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition,
    links: [{ ...composition.links[0], fromPort: 'middle' }],
  } }], 20), /port/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition,
    links: [{ ...composition.links[0], fromPort: ['right'] }],
  } }], 20), /port/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition,
    links: [{ ...composition.links[0], toPort: 'url(secret)' }],
  } }], 20), /port/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition, nodes: [{ ...node, x: Infinity }] } }], 20), /geometry/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition, nodes: [{ ...node, kind: 'script' }] } }], 20), /type/);
  assert.throws(() => parsePresentationVisuals([{ ...scene, composition: { ...composition, links: [
    { ...composition.links[0], reveal: 0 },
  ] } }], 20), /connection/);
});

test('desktop validates drawn graphics, roles, build states and the presenter frame at its trust boundary', () => {
  const hero = { id: 'hero', kind: 'asset', asset: 'foundation', role: 'hero', x: 120, y: 250, width: 300, height: 372,
    label: 'Operating model', detail: '', icon: '', tone: 'teal', reveal: 1,
    states: [{ at: 2, focus: true }, { at: 3, x: 200, y: 280, scale: 0.8, opacity: 0.9 }] };
  const gauge = { id: 'gauge', kind: 'icon', role: 'secondary', x: 560, y: 300, width: 200, height: 220,
    label: 'Quality', detail: '', icon: 'gauge', tone: 'blue', reveal: 2 };
  const composition = { label: 'Operating model', imagePrompt: '', frame: 'around-presenter', nodes: [hero, gauge], links: [] };
  const scene = { id: 'framed', template: 'concept', title: 'Work becoming organised', subtitle: '', imageUrl: '', imageAlt: '',
    presenterLayout: true, at: 0, composition, items: [10, 20, 30].map(at => ({ label: `Step ${at / 10}`, detail: '', at })) };
  assert.deepEqual(parsePresentationVisuals([scene], 40), [scene]);
  const link = { from: 'hero', to: 'gauge', label: '', tone: 'teal', reveal: 2, style: 'solid' };
  const changed = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => [{ ...scene,
    composition: { ...composition, ...extra, nodes: [{ ...hero, ...patch }, gauge] } }];
  const rejected: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown asset', { asset: 'dragon' }, /asset/],
    ['an asset name on a panel', { kind: 'panel' }, /asset/],
    ['an unknown role', { role: 'giant' }, /role/],
    ['a role on a text node', { kind: 'text', asset: undefined, role: 'hero' }, /role/],
    ['an unknown icon', { icon: 'rocket' }, /node type/],
    ['too many states', { states: [1, 2, 3, 4, 5].map(at => ({ at, focus: true })) }, /states/],
    ['a repeated state reveal', { states: [{ at: 2, focus: true }, { at: 2, focus: false }] }, /state order/],
    ['an empty state', { states: [{ at: 2 }] }, /composition state\./],
    ['a non-boolean focus', { states: [{ at: 2, focus: 'yes' }] }, /focus/],
    ['a scale beyond range', { states: [{ at: 2, scale: 3 }] }, /geometry/],
    ['a state outside the stage', { states: [{ at: 2, x: 1500 }] }, /outside the stage/],
  ];
  for (const [name, patch, error] of rejected) assert.throws(() => parsePresentationVisuals(changed(patch), 40), error, name);
  assert.throws(() => parsePresentationVisuals(changed({}, { frame: 'fullscreen' }), 40), /frame/);
  assert.throws(() => parsePresentationVisuals(changed({}, { links: [link] }), 40), /connected/);
  assert.ok(parsePresentationVisuals(changed({ states: [{ at: 2, focus: true }] }, { links: [link] }), 40));
});

test('desktop accepts standalone static headers and typographic titles, not image/diagram mixtures', () => {
  const composition = { label: 'Chapter one', imagePrompt: '', nodes: [], links: [] };
  const title = { id: 'one', template: 'title', title: 'Human responsibility', subtitle: '', imageUrl: '', imageAlt: '',
    at: 0, items: [], composition };
  assert.deepEqual(parsePresentationVisuals([title], 20)?.[0]?.composition, composition);
  assert.throws(() => parsePresentationVisuals([{ ...title, template: 'concept' }], 20), /nodes|composition/i);
  for (const imageTreatment of ['full', 'blend']) {
    const header = { ...title, imageUrl: 'https://images.example/header.png', composition: { ...composition, imageTreatment } };
    assert.deepEqual(parsePresentationVisuals([header], 20)?.[0]?.composition, header.composition);
    assert.throws(() => parsePresentationVisuals([{ ...header, imageUrl: '' }], 20), /header|image/i);
    assert.throws(() => parsePresentationVisuals([{ ...header, template: 'concept' }], 20), /header|image/i);
    assert.throws(() => parsePresentationVisuals([{ ...header, items: [{ label: 'Build', detail: '', at: 1 }] }], 20), /header/i);
  }
  for (const mode of ['guide', 'camera', 'off']) assert.equal(parseVisualVideoMode(mode), mode);
  assert.throws(() => parseVisualVideoMode('automatic'), /Guide, Camera or Off/);
});

test('local scene delivery holds scenes, reverses reveals and rejects cross-origin, wrong-token and arbitrary write access', async () => {
  const output = new VisualOutput(join(__dirname, '../../assets'));
  try {
    const [url, same] = await Promise.all([output.open(), output.open()]);
    assert.equal(url, same);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(page.headers.get('permissions-policy'), 'camera=(self), microphone=()');
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    await page.text();
    const assets = await fetch(new URL('visualAssets.js', url));
    assert.equal(assets.status, 200);
    assert.equal(assets.headers.get('content-type'), 'text/javascript');
    assert.match(await assets.text(), /export const VISUAL_ASSETS/);
    assert.equal((await fetch(new URL('/wrong/', url))).status, 404);
    assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    const scenes = [{ id: 'one', template: 'concept' as const, title: 'Concept', subtitle: '', imageUrl: '', imageAlt: '', at: 0,
      items: [{ label: 'First', detail: '', at: 10 }, { label: 'Second', detail: '', at: 30 }] }];
    const packet = async (): Promise<{ revealed: number; scene: { id: string }; page: number; total: number; presentationTitle: string }> => {
      const response = await fetch(new URL('events', url));
      const reader = response.body!.getReader();
      const first = await reader.read();
      await reader.cancel();
      return JSON.parse(new TextDecoder().decode(first.value).replace(/^data: /, '').trim());
    };
    output.update(scenes, 35, null, 'Delegation explained');
    const first = await packet();
    assert.equal(first.revealed, 2);
    assert.equal(first.page, 1);
    assert.equal(first.total, 1);
    assert.equal(first.presentationTitle, 'Delegation explained');
    output.update(scenes, 15, null);
    const reversed = await packet();
    assert.equal(reversed.scene.id, 'one');
    assert.equal(reversed.revealed, 1);
    output.update(scenes, 0, null);
    assert.equal((await packet()).revealed, 0);
    output.close();
    await assert.rejects(fetch(url));
  } finally { output.close(); }
});

test('camera feedback is status-only, selected-client scoped, bounded and ordered within the manual request', { timeout: 10_000 }, async () => {
  const output = new VisualOutput(join(__dirname, '../../assets'));
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const url = await output.open();
    const headers = { Origin: new URL(url).origin, 'Content-Type': 'application/json' };
    const connect = async (): Promise<{ videoClientId: string; video: VisualVideoState }> => {
      const response = await fetch(new URL('events', url));
      const reader = response.body!.getReader();
      readers.push(reader);
      let buffer = '';
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += new TextDecoder().decode(chunk.value);
      }
      return JSON.parse(buffer.slice(6, buffer.indexOf('\n\n')));
    };
    output.setVideoMode('camera');
    const first = await connect();
    const second = await connect();
    assert.equal(first.video.mode, 'camera');
    assert.equal(second.video.mode, 'off');
    const receipt = { clientId: first.videoClientId, requestId: first.video.requestId, sequence: 2, status: 'active', error: null };
    const send = (body: object, origin = headers.Origin): Promise<Response> => fetch(new URL('video-status', url),
      { method: 'POST', headers: { ...headers, Origin: origin }, body: JSON.stringify(body) });
    assert.equal((await send(receipt, 'https://untrusted.example')).status, 403);
    assert.equal((await send({ ...receipt, clientId: second.videoClientId })).status, 409);
    assert.equal((await send({ ...receipt, requestId: 'previous-request' })).status, 409);
    assert.equal((await send({ ...receipt, sequence: 0 })).status, 400);
    assert.equal((await send({ ...receipt, status: ['active'] })).status, 400);
    assert.equal((await send({ ...receipt, command: 'camera' })).status, 400);
    assert.equal((await send({ ...receipt, status: 'error', error: 'x'.repeat(1200) })).status, 413);
    assert.equal((await send(receipt)).status, 204);
    assert.equal(output.videoState().status, 'active');
    assert.equal((await send({ ...receipt, sequence: 1, status: 'requesting' })).status, 204);
    assert.equal(output.videoState().status, 'active');
    output.setVideoMode('off');
    assert.equal((await send({ ...receipt, sequence: 3 })).status, 409);
    assert.equal(output.videoState().mode, 'off');
    output.setVideoMode('camera');
    assert.notEqual(output.videoState().requestId, receipt.requestId);
    output.close();
    assert.equal(output.videoState().mode, 'off');
  } finally {
    await Promise.all(readers.map(reader => reader.cancel()));
    output.close();
  }
});

test('desktop commands reject stale, unknown and unbounded input', () => {
  const command = { id: 'test', command: 'new-note', issuedAt: Date.now() };
  assert.equal(parseCommand(command).command, 'new-note');
  assert.throws(() => parseCommand({ ...command, command: 'shell' }));
  assert.throws(() => parseCommand({ ...command, extra: 'file' }));
  assert.throws(() => parseCommand({ ...command, id: '' }));
  assert.throws(() => parseCommand({ ...command, issuedAt: Date.now() - 31_000 }));
  assert.throws(() => parseCommand({ ...command, issuedAt: NaN }));
});
test('manual transport changes actual speed, bounds font and resets explicitly', () => {
  const ready = { ...initialPresentation(), displayId: -1, sessionId: 'session', progress: 0.4 };
  assert.throws(() => playbackCommand(initialPresentation(), 'play'));
  let next = playbackCommand(ready, 'play');
  assert.equal(next.status, 'playing');
  next = playbackCommand(next, 'pause');
  assert.equal(next.progress, 0.4);
  assert.equal(next.status, 'paused');
  next = playbackCommand(next, 'faster');
  assert.equal(next.speed, 82);
  assert.equal(playbackCommand(next, 'slower').speed, 80);
  assert.equal(next.progress, 0.4);
  assert.equal(playbackCommand({ ...next, speed: 300 }, 'faster').speed, 300);
  assert.equal(playbackCommand({ ...next, speed: 10 }, 'slower').speed, 10);
  assert.equal(playbackCommand({ ...next, speed: 299 }, 'faster').speed, 300);
  assert.equal(playbackCommand({ ...next, speed: 11 }, 'slower').speed, 10);
  assert.equal(playbackCommand({ ...next, fontSize: 96 }, 'text-larger').fontSize, 96);
  assert.equal(playbackCommand({ ...next, fontSize: 24 }, 'text-smaller').fontSize, 24);
  assert.equal(playbackCommand(next, 'stop').progress, 0);
  assert.equal(playbackCommand({ ...next, status: 'ended', progress: 1 }, 'play').progress, 0);
});
test('presentation formatting accepts only bounded text and supported styles with a matching plain snapshot', () => {
  const runs = [{ text: 'Bold', styles: ['bold', 'italic'] }, { text: '\n- Item', styles: [] }];
  assert.deepEqual(parsePresentationRuns(runs, 'Bold\n- Item'), runs);
  assert.equal(parsePresentationRuns(undefined, 'Legacy plain script'), undefined);
  assert.throws(() => parsePresentationRuns(runs, 'Different snapshot'), /does not match/);
  assert.throws(() => parsePresentationRuns([{ text: 'x', styles: ['onclick'] }], 'x'), /invalid/);
  assert.throws(() => parsePresentationRuns([{ text: 'x', styles: [], html: '<script>' }], 'x'), /invalid/);
  assert.throws(() => parsePresentationRuns([{ text: 'x'.repeat(500_001), styles: [] }], ''), /too large/);
  assert.throws(() => parsePresentationRuns([null], ''), /invalid/);
});
test('formatted output uses literal text nodes and style classes, and clears marks for a plain script', async () => {
  let update: (value: unknown) => void = () => {};
  type Span = { textContent: string; classList: { add: (value: string) => void; remove: (value: string) => void };
    classes: string[]; children: Span[]; dataset: Record<string, string>; offsetTop: number; appendChild: (child: Span) => void };
  const node = (value = ''): Span => {
    const classes: string[] = [];
    const children: Span[] = [];
    return { get textContent() { return value + children.map(child => child.textContent).join(''); },
      set textContent(text: string) { value = text; }, classes, children, dataset: {}, offsetTop: 0,
      classList: { add: name => { classes.push(name); }, remove: name => { const i = classes.indexOf(name); if (i >= 0) classes.splice(i, 1); } },
      appendChild: child => { children.push(child); } };
  };
  let children: Span[] = [];
  let text = '';
  const script = {
    style: {},
    get textContent(): string { return text; },
    set textContent(value: string) { text = value; children = []; },
    replaceChildren: (fragment: { children: Span[] }) => { children = fragment.children; },
  };
  const context = createContext({
    NodeFilter: { SHOW_TEXT: 4 },
    window: { athenaOutput: { onUpdate: (fn: typeof update) => { update = fn; }, report: () => {} } },
    document: {
      getElementById: (id: string) => id === 'viewport' ? { clientHeight: 100, scrollHeight: 100, scrollTop: 0,
        addEventListener: () => {}, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) } : script,
      createTreeWalker: () => ({ nextNode: () => null }),
      body: { classList: { toggle: () => {} } },
      createElement: (tag: string): Span => {
        assert.equal(tag, 'span');
        return node();
      },
      createTextNode: node,
      createDocumentFragment: () => {
        const fragment = { children: [] as Span[], appendChild: (span: Span) => { fragment.children.push(span); } };
        return fragment;
      },
    },
    requestAnimationFrame: () => {},
    ResizeObserver: class { observe() {} },
  });
  runInContext(await readFile(join(__dirname, '../../assets/presentation.js'), 'utf8'), context);
  const state = { ...initialPresentation(), sessionId: 'formatted', displayId: 1 };
  const literal = '<img src=x onerror=alert(1)>';
  update({ state, text: literal + '\n- Item', runs: [
    { text: literal, styles: ['bold', 'italic'] }, { text: '\n- Item', styles: [] },
  ], sequence: 1, reset: true });
  assert.equal(children.map(span => span.textContent).join(''), literal + '\n- Item');
  assert.deepEqual(children[0]?.children[0]?.classes, ['script-bold', 'script-italic']);
  const formatted = children;
  update({ state, sequence: 2 });
  assert.equal(children, formatted);
  update({ state, text: 'Plain replacement', sequence: 3, reset: true });
  assert.equal(children.map(span => span.textContent).join(''), 'Plain replacement');
  assert.deepEqual(children[0]?.children[0]?.classes, []);
});
test('output acknowledges commands, maintains fractional pace, pauses immediately and resets', async () => {
  let update: (value: unknown) => void = () => {};
  let tick: (time: number) => void = () => {};
  let top = 0;
  const viewport = {
    clientHeight: 100, scrollHeight: 1100,
    addEventListener: () => {}, getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
    get scrollTop(): number { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(1000, Math.round(value))); },
  };
  const reports: { progress: number; ack?: number }[] = [];
  const script = { style: {}, textContent: '', replaceChildren(fragment: { text: string }) { this.textContent = fragment.text; } };
  const context = createContext({
    NodeFilter: { SHOW_TEXT: 4 },
    window: { athenaOutput: {
      onUpdate: (fn: typeof update) => { update = fn; },
      report: (value: typeof reports[number]) => reports.push(value),
    } },
    document: { getElementById: (id: string) => id === 'viewport' ? viewport : script, body: { classList: { toggle: () => {} } },
      createTreeWalker: () => ({ nextNode: () => null }),
      createElement: () => ({ textContent: '', dataset: {}, offsetTop: 0, classList: { add: () => {}, remove: () => {} },
        appendChild(child: { textContent: string }) { this.textContent += child.textContent; } }),
      createTextNode: (textContent: string) => ({ textContent }),
      createDocumentFragment: () => {
        const children: { textContent: string }[] = [];
        return { get text() { return children.map(child => child.textContent).join(''); },
          appendChild(child: { textContent: string }) { children.push(child); } };
      } },
    requestAnimationFrame: (fn: typeof tick) => { tick = fn; },
    ResizeObserver: class { observe() {} },
  });
  runInContext(await readFile(join(__dirname, '../../assets/presentation.js'), 'utf8'), context);
  const state = { ...initialPresentation(), sessionId: 'one', displayId: 1, status: 'playing' };
  update({ state, text: '<img src=x onerror=alert(1)>', sequence: 1, reset: true });
  assert.equal(script.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(reports[0]?.ack, 1);
  for (let i = 0; i <= 60; i++) tick(i * (1000 / 60));
  assert.ok(Math.abs(top - 80) <= 1, `Expected 80px in one second, got ${top}`);
  update({ state: { ...state, status: 'paused' }, sequence: 2 });
  const paused = top;
  tick(1100); tick(1200);
  assert.equal(top, paused);
  update({ state: { ...state, status: 'ready', progress: 0 }, sequence: 3, reset: true });
  assert.equal(top, 0);
  update({ state: { ...state, speed: 300 }, sequence: 4 });
  for (let i = 0; i <= 600; i++) tick(1300 + i * (1000 / 60));
  assert.equal(top, 1000);
  assert.equal(reports.at(-1)?.progress, 1);
});
test('loopback bridge authenticates, rejects browser calls and deduplicates writes without replay', async () => {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  let writes = 0;
  const bridge = new ElgatoBridge(async () => { writes++; }, () => ({
    protocol: 1, presentation: initialPresentation(), recording: false, transcribing: false, error: null,
  }));
  const token = 'a'.repeat(64);
  await bridge.start(token, port);
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/state`)).status, 403);
    assert.equal((await fetch(`${base}/state`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/state`, { headers })).status, 200);
    const body = JSON.stringify({ id: 'same', command: 'new-note', issuedAt: Date.now() });
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body })).status, 200);
    assert.equal(writes, 1);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ id: 'x', command: 'shell', issuedAt: Date.now() }) })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ id: 'x', command: 'new-note', issuedAt: Date.now() - 31_000 }) })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: ' '.repeat(2049) })).status, 413);
    assert.equal(writes, 1);
  } finally { await bridge.stop(); }
  await assert.rejects(fetch(`${base}/state`, { headers }));
});

test('presentation IPC confirms scaled negative-coordinate displays, protects ownership and stops on unplug', async () => {
  class Demo {
    static instances: Demo[] = [];
    isReady = false;
    resetCalls: (number | null)[] = [];
    resetWait: Promise<void> | null = null;
    resetError: Error | null = null;
    constructor() { Demo.instances.push(this); }
    async open(): Promise<void> { this.isReady = true; }
    async reset(prompterId: number | null): Promise<void> {
      this.resetCalls.push(prompterId);
      if (this.resetWait) await this.resetWait;
      if (this.resetError) throw this.resetError;
    }
    update(): void {}
    close(): void { this.isReady = false; }
    displayChanged(): void {}
  }
  class Contents extends EventEmitter {
    static next = 0;
    id = ++Contents.next;
    mainFrame = { url: 'https://athena.example/present' };
    messages: { channel: string; value: unknown }[] = [];
    send(channel: string, value: unknown): void {
      this.messages.push({ channel, value });
      if (channel === 'presentation:update') {
        const update = value as { sequence: number; state: { sessionId: string; progress: number } };
        ipc.emit('presentation:progress', event(this), { sessionId: update.state.sessionId, progress: update.state.progress, ack: update.sequence });
      } else if (channel === 'desktop:command') {
        ipc.emit('desktop:reply', event(this), { id: (value as { id: string }).id });
      } else if (channel === 'desktop:request-ready') {
        ipc.emit('desktop:ready', event(this));
      }
    }
    setWindowOpenHandler(): void {}
    getURL(): string { return this.mainFrame.url; }
  }
  class Window extends EventEmitter {
    static instances: Window[] = [];
    static getAllWindows(): Window[] { return Window.instances.filter(window => !window.destroyed); }
    webContents = new Contents();
    destroyed = false;
    inactive = false;
    focused = false;
    constructor(public options: Record<string, unknown> = {}) { super(); Window.instances.push(this); }
    isDestroyed(): boolean { return this.destroyed; }
    show(): void {}
    focus(): void { this.focused = true; }
    showInactive(): void { this.inactive = true; }
    setBounds(bounds: unknown): void { this.options.bounds = bounds; }
    setOpacity(opacity: number): void { this.options.opacity = opacity; }
    close(): void { this.destroyed = true; this.emit('closed'); }
    async loadFile(): Promise<void> {
      this.webContents.mainFrame.url = 'file:///presentation.html';
      ipc.emit('presentation:ready', event(this.webContents));
    }
    async loadURL(): Promise<void> {}
  }
  const event = (sender: Contents): { sender: Contents; senderFrame: { url: string } } => ({ sender, senderFrame: sender.mainFrame });
  const ipc = new EventEmitter();
  type IpcHandler = (source: ReturnType<typeof event>, value?: unknown) => Promise<unknown>;
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = Object.assign(ipc, { handle: (name: string, fn: IpcHandler): void => { handlers.set(name, fn); } });
  const displays = new EventEmitter();
  let available = [{ id: 42, label: 'Elgato Prom.', size: { width: 2560, height: 1440 },
    bounds: { x: -1707, y: 100, width: 1707, height: 960 }, scaleFactor: 1.5 }];
  let awake = 0;
  const app = Object.assign(new EventEmitter(), { getPath: () => 'fixture', getAppPath: () => 'fixture' });
  const electron = {
    BrowserWindow: Window, app, ipcMain,
    screen: Object.assign(displays, { getAllDisplays: () => available, getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 3440, height: 1440 } }) }),
    clipboard: { writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => true },
    powerSaveBlocker: { start: () => ++awake, stop: () => { awake--; } },
  };
  const realRequire = createRequire(join(__dirname, '../src/elgato.js'));
  let savedConfig: string | null = null;
  let wakes = 0;
  let failWake = false;
  const wakeWarnings: unknown[][] = [];
  const exported: { exports: unknown } = { exports: {} };
  const context = createContext({
    exports: exported.exports, module: exported, __dirname: join(__dirname, '../src'),
    require: (name: string): unknown => {
      if (name === 'electron') return electron;
      if (name === './demoOutput') return { DemoOutput: Demo };
      if (name === './displayWake') return { wakePresentationDisplay: async () => {
        wakes++;
        if (failWake) throw new Error('Fixture Windows wake request failed');
      } };
      if (name === 'node:fs/promises') return {
        readFile: async () => {
          if (savedConfig) return savedConfig;
          throw Object.assign(new Error('Not configured'), { code: 'ENOENT' });
        },
        writeFile: async (_path: string, value: string) => { savedConfig = value; }, rename: async () => {},
      };
      return realRequire(name);
    },
    console: { ...console, warn: (...values: unknown[]) => { wakeWarnings.push(values); } },
    Buffer, URL, Error, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  runInContext(await readFile(join(__dirname, '../src/elgato.js'), 'utf8'), context);
  const { installElgato } = exported.exports as {
    installElgato: (origin: string, create: (path: string) => Window, open: (mode: 'workspace' | 'chat') => Window) => () => void;
  };
  const workspace = new Window();
  const openedModes: string[] = [];
  const setup = installElgato('https://athena.example', () => new Window(), mode => { openedModes.push(mode); return workspace; });
  setup();
  let controller = Window.instances.at(-1)!;
  async function invoke(name: string, value?: unknown, owner = controller): Promise<unknown> {
    const handler = handlers.get(name);
    assert.ok(handler);
    return handler(event(owner.webContents), value);
  }
  await assert.rejects(invoke('presentation:displays', undefined, workspace), /cannot control/);
  await assert.rejects(invoke('presentation:direct', { noteId: 'note-1', title: 'Script', text: 'Saved words' }, workspace), /from Think/);
  ipc.emit('desktop:ready', event(workspace.webContents));
  await invoke('presentation:command', { id: 'new-note', command: 'new-note', issuedAt: Date.now() });
  assert.ok(workspace.webContents.messages.some(message => message.channel === 'desktop:command'));
  workspace.webContents.emit('did-start-loading');
  await invoke('presentation:command', { id: 'new-diagram-after-navigation', command: 'new-diagram', issuedAt: Date.now() });
  await invoke('presentation:command', { id: 'speak-main', command: 'speak', issuedAt: Date.now() });
  assert.deepEqual(openedModes, ['workspace', 'workspace', 'workspace']);
  assert.equal(workspace.webContents.messages.filter(message => message.channel === 'desktop:request-ready').length, 3);
  await invoke('desktop:voice-state', { recording: true, transcribing: false }, workspace);
  assert.equal((await invoke('presentation:state') as { recording: boolean }).recording, true);
  const chat = new Window();
  chat.webContents.mainFrame.url = 'https://athena.example/chat';
  await invoke('desktop:voice-state', { recording: false, transcribing: false }, chat);
  assert.equal((await invoke('presentation:state') as { recording: boolean }).recording, true);
  await assert.rejects(invoke('desktop:voice-state', { recording: 'yes', transcribing: false }, workspace), /Invalid voice state/);
  await invoke('desktop:voice-state', { recording: false, transcribing: false }, workspace);
  const info = await invoke('presentation:displays') as { id: number; scale: number }[];
  assert.equal(info[0]?.id, 42);
  assert.equal(info[0]?.scale, 1.5);
  const script = { noteId: 'note-1', title: 'Script', text: 'Saved words', displayId: 42 };
  await invoke('presentation:start', script);
  const output = Window.instances.at(-1)!;
  assert.equal(output.options.x, -1707);
  assert.equal(output.options.width, 1707);
  assert.equal(output.options.focusable, false);
  assert.equal(output.inactive, true);
  assert.equal(output.focused, false);
  assert.match(String((output.options.webPreferences as { preload: string }).preload), /outputPreload/);
  await invoke('presentation:command', { id: 'play', command: 'play', issuedAt: Date.now() });
  assert.equal(awake, 1);
  const current = await invoke('presentation:state') as { presentation: { sessionId: string; progress: number; status: string; displayId: number | null } };
  ipc.emit('presentation:progress', event(output.webContents), { sessionId: 'stale', progress: 0.9 });
  assert.equal(current.presentation.progress, 0);
  ipc.emit('presentation:progress', event(output.webContents), { sessionId: current.presentation.sessionId, progress: 0.45 });
  const removed = available[0]!;
  available = [];
  displays.emit('display-removed', {}, removed);
  assert.equal(output.destroyed, true);
  assert.equal(awake, 0);
  const lost = await invoke('presentation:state') as typeof current;
  assert.equal(lost.presentation.status, 'disconnected');
  assert.equal(lost.presentation.displayId, null);
  assert.equal(lost.presentation.progress, 0.45);
  await assert.rejects(invoke('presentation:start', script), /available output/);
  available = [{ ...removed, id: 43 }];
  await invoke('presentation:start', { ...script, displayId: 43 });
  const resumed = await invoke('presentation:state') as typeof current;
  assert.equal(resumed.presentation.status, 'ready');
  assert.equal(resumed.presentation.progress, 0.45);
  assert.equal(awake, 0);
  await invoke('presentation:options', { mirror: true, flip: false, opacity: 65 });
  await invoke('presentation:command', { id: 'faster', command: 'faster', issuedAt: Date.now() });
  await invoke('presentation:command', { id: 'text-larger', command: 'text-larger', issuedAt: Date.now() });
  assert.equal(Window.instances.at(-1)!.options.opacity, 0.65);
  await assert.rejects(invoke('presentation:options', { mirror: false, flip: false, opacity: 0 }), /Invalid output/);
  workspace.webContents.mainFrame.url = 'https://athena.example/think';
  const count = Window.instances.length;
  failWake = true;
  await invoke('presentation:direct', { noteId: 'note-2', title: 'Direct', text: 'Direct words' }, workspace);
  assert.equal(wakeWarnings.length, 1);
  assert.match(String(wakeWarnings[0]?.[0]), /continuing on the available output display/);
  failWake = false;
  assert.equal(Window.instances.length, count + 1);
  assert.ok(wakes >= 3);
  const direct = Window.instances.at(-1)!;
  await invoke('presentation:command', { id: 'direct-play', command: 'play', issuedAt: Date.now() });
  await invoke('presentation:command', { id: 'direct-pause', command: 'pause', issuedAt: Date.now() });
  await invoke('presentation:command', { id: 'direct-play-again', command: 'play', issuedAt: Date.now() });
  assert.equal(Window.instances.length, count + 1);
  assert.equal(direct.webContents.messages.filter(message => message.channel === 'presentation:update' && 'text' in (message.value as object)).length, 1);
  await invoke('presentation:release', undefined, controller);
  assert.equal(direct.destroyed, false);
  assert.equal(direct.inactive, true);
  assert.equal(direct.options.opacity, 0.65);
  await invoke('presentation:direct', { noteId: 'note-2', title: 'Direct', text: 'Direct words' }, workspace);
  assert.equal(Window.instances.length, count + 1);
  controller.close();
  assert.equal(direct.destroyed, false);
  workspace.webContents.emit('did-start-loading');
  assert.equal(direct.destroyed, true);
  available = [];
  await assert.rejects(invoke('presentation:direct', { noteId: 'note-2', title: 'Direct', text: 'Direct words' }, workspace), /Set your output display once/);
  assert.ok(savedConfig);
  assert.doesNotMatch(savedConfig, /Direct words|Saved words/);
  const saved = JSON.parse(savedConfig);
  assert.deepEqual(saved.settings, { speed: 82, fontSize: 68, mirror: true, flip: false, opacity: 65 });
  assert.equal(saved.noteId, 'note-2');
  available = [{ ...removed, id: 44 }];
  const restartSetup = installElgato('https://athena.example', () => new Window(), () => workspace);
  restartSetup();
  controller = Window.instances.at(-1)!;
  const beforeRestartPresent = Window.instances.length;
  await invoke('presentation:direct', { noteId: 'note-2', title: 'Direct', text: 'Direct words' }, workspace);
  assert.equal(Window.instances.length, beforeRestartPresent + 1);
  assert.equal(Window.instances.at(-1)!.options.opacity, 0.65);
  assert.equal(Window.instances.at(-1)!.options.x, -1707);
  const restored = Window.instances.at(-1)!.webContents.messages.find(message => message.channel === 'presentation:update')!.value as { state: { speed: number; fontSize: number; mirror: boolean } };
  assert.equal(restored.state.speed, 82);
  assert.equal(restored.state.fontSize, 68);
  assert.equal(restored.state.mirror, true);
  // Stop resets playback; Stop presenting closes output without closing its source.
  const reopened = Window.instances.at(-1)!;
  await invoke('presentation:command', { id: 'restart-play', command: 'play', issuedAt: Date.now() });
  await invoke('presentation:command', { id: 'restart-stop', command: 'stop', issuedAt: Date.now() });
  assert.equal(reopened.destroyed, false);
  await invoke('presentation:command', { id: 'stop-presenting', command: 'stop-presenting', issuedAt: Date.now() });
  assert.equal(reopened.destroyed, true);
  assert.equal(workspace.destroyed, false);
  assert.equal(awake, 0);
  await invoke('presentation:direct', { noteId: 'note-2', title: 'Direct', text: 'Direct words' }, workspace);
  await assert.rejects(invoke('presentation:close', undefined, chat), /Stop presenting from Think/);
  assert.equal(Window.instances.at(-1)!.destroyed, false);
  await invoke('presentation:close', undefined, workspace);
  assert.equal(Window.instances.at(-1)!.destroyed, true);
  assert.equal(workspace.destroyed, false);
  await invoke('presentation:direct', { noteId: 'note-2', title: 'Direct', text: 'Direct words' }, workspace);
  await invoke('presentation:release', undefined, workspace);
  assert.equal(Window.instances.at(-1)!.destroyed, true);

  const demo = Demo.instances.at(-1)!;
  assert.deepEqual(demo.resetCalls, []);
  available.push({ ...removed, id: 45, label: 'Demo' });
  const walkthrough = { noteId: 'demo-1', title: 'Demo', text: 'Saved words', displayId: 44,
    demo: [{ action: 'inspect', target: 'workforce-summary', at: 1 }] };
  await invoke('presentation:start', walkthrough);
  const demoOutput = Window.instances.at(-1)!;
  await invoke('presentation:demo', { ...walkthrough, demoDisplayId: 45 });
  await invoke('presentation:command', { id: 'demo-play', command: 'play', issuedAt: Date.now() });
  const demoState = await invoke('presentation:state') as typeof current;
  ipc.emit('presentation:progress', event(demoOutput.webContents), { sessionId: demoState.presentation.sessionId, progress: 0.5, position: 5 });
  let release!: () => void;
  demo.resetWait = new Promise(resolve => { release = resolve; });
  const stopping = invoke('presentation:command', { id: 'demo-stop', command: 'stop', issuedAt: Date.now() });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(demo.resetCalls, [44]);
  const stopped = await invoke('presentation:state') as typeof current;
  assert.equal(stopped.presentation.status, 'ready');
  assert.equal(stopped.presentation.progress, 0);
  await assert.rejects(invoke('presentation:command', { id: 'demo-early-play', command: 'play', issuedAt: Date.now() }), /still loading/);
  await assert.rejects(invoke('presentation:demo', { ...walkthrough, demoDisplayId: 45 }), /already opening or resetting/);
  release();
  await stopping;
  demo.resetWait = null;
  await invoke('presentation:command', { id: 'demo-play-again', command: 'play', issuedAt: Date.now() });
  demo.resetError = new Error('Demo reset failed');
  await assert.rejects(invoke('presentation:command', { id: 'demo-stop-failure', command: 'stop', issuedAt: Date.now() }), /Demo reset failed/);
  const failed = await invoke('presentation:state') as { presentation: { status: string; progress: number }; error: string | null };
  assert.equal(failed.presentation.status, 'ready');
  assert.equal(failed.presentation.progress, 0);
  assert.match(failed.error ?? '', /Demo reset failed/);
  demo.close();
  await invoke('presentation:command', { id: 'plain-stop', command: 'stop', issuedAt: Date.now() });
  assert.deepEqual(demo.resetCalls, [44, 44]);
});
