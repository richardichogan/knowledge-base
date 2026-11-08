import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { connectionGeometry, connectionRing } from '../assets/visualGeometry';
import type { createPresenterVideo } from '../assets/visualVideo';
import type { VisualNode, VisualVideoState } from '../assets/visualComposition';
import type { alignVisualNodes, visualBuildSteps, visualNodeState } from '../assets/visuals';
import type { buildVisualAsset, VISUAL_ASSETS, VisualAssetPart } from '../assets/visualAssets';

test('preview and audience group simultaneous cues into the same visual build', async () => {
  const context = createContext({});
  runInContext((await readFile(join(__dirname, '../../assets/visuals.js'), 'utf8'))
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
  const steps: typeof visualBuildSteps = context.visualBuildSteps;
  assert.deepEqual(Array.from(steps([])), [0]);
  assert.deepEqual(Array.from(steps([{ at: 10 }, { at: 10 }, { at: 40 }, { at: 60 }, { at: 60 }])), [0, 2, 3, 5]);
  const cue = (blockId: string, quote: string) => ({ cue: { blockId, quote } });
  assert.deepEqual(Array.from(steps([cue('a', 'work'), cue('a', 'work'), cue('a', 'roles'), cue('b', 'roles')])), [0, 2, 3, 4]);
  assert.deepEqual(Array.from(steps([{}, {}, {}])), [0, 1, 2, 3]);
});

const geometryContext = async () => {
  const context = createContext({});
  runInContext((await readFile(join(__dirname, '../../assets/visualGeometry.js'), 'utf8')).replace(/^export /gm, ''), context);
  return { route: context.connectionGeometry as typeof connectionGeometry, ring: context.connectionRing as typeof connectionRing };
};

test('presentation logo uses the official reversed white artwork with no background', async () => {
  const source = await readFile(join(__dirname, '../../assets/visuals.js'), 'utf8');
  const context = createContext({ html: (_tag: string, className: string) => ({ className }) });
  runInContext(source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
  const start = source.indexOf('  function brandLogo(');
  const end = source.indexOf('  function illustration(', start);
  runInContext(source.slice(start, end), context);
  const logo = context.brandLogo();
  assert.equal(logo.className, 'slide-brand');
  assert.equal(logo.alt, 'IBM eight-bar logo');
  const svg = decodeURIComponent(logo.src.replace('data:image/svg+xml,', ''));
  assert.match(svg, /viewBox="57.6 61.7 1109.6 440.2" fill="#ffffff"/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 17);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject|style=|background|<text/);
  assert.match(svg, /M304.2,473.9v28h227c29.1,0,55.8-10.6,76.2-28H304.2z/);
});

test('only the dedicated close scene carries the logo, regardless of slide position', async () => {
  const source = await readFile(join(__dirname, '../../assets/visuals.js'), 'utf8');
  const logo = {};
  const children: object[] = [];
  const layer = { append(item: object) { children.push(item); }, querySelectorAll() { return []; } };
  const context = createContext({
    layer, signature: '', sceneRevision: 0, imageError: '', packetError: '', wantsMotion: false, live: false,
    renderedSection: null, openingDelay: 0, stated: [], ring: null, previousRevealed: -1, buildSteps: [],
    animations: new Map(), reveals: new Map(),
    presenterVideo: { update() {} }, slide: { classList: { toggle() {} } },
    presentationTitle: {}, pageNumber: {}, footer: {}, progress: {}, progressFill: { style: {} },
    showStatus() {}, setLive() {}, stopLoops() {}, setCloseMarks() {}, setReveals() {},
    closeScene() {}, titleScene() {}, composed() {}, legacy() {}, brandLogo: () => logo,
    replaceLayer() { children.length = 0; },
  });
  runInContext(source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
  const start = source.indexOf('  function render(packet)');
  const end = source.indexOf('  render.disconnectVideo', start);
  runInContext(source.slice(start, end), context);
  for (const scene of [
    { template: 'close' },
    { template: 'title', composition: { nodes: [] } },
    { template: 'title', composition: { nodes: [{ id: 'heading' }] } },
    { template: 'title' },
  ]) {
    const packet = { scene, page: 1, total: 2, revealed: 0, animate: false };
    context.render(packet);
    assert.equal(children.length, scene.template === 'close' ? 1 : 0);
    context.render({ ...packet, total: 1 });
    assert.deepEqual(children, scene.template === 'close' ? [logo] : []);
    context.render({ ...packet, total: 1, revealed: 1 });
    assert.deepEqual(children, scene.template === 'close' ? [logo] : []);
    context.render(packet);
    assert.equal(children.length, scene.template === 'close' ? 1 : 0);
  }
});

test('lifecycle arcs share one clockwise ring and stop short of each stage for the arrowhead', async () => {
  const { route, ring } = await geometryContext();
  const nodes = [
    { id: 'top', bounds: { x: 660, y: 245, width: 280, height: 70 } },
    { id: 'right', bounds: { x: 1060, y: 485, width: 280, height: 70 } },
    { id: 'bottom', bounds: { x: 660, y: 725, width: 280, height: 70 } },
    { id: 'left', bounds: { x: 260, y: 485, width: 280, height: 70 } },
  ];
  const links = nodes.map((node, index) => ({ from: node.id, to: nodes[(index + 1) % nodes.length]!.id, route: 'arc' as const,
    label: '', tone: 'teal' as const, style: 'solid' as const, reveal: 0 }));
  const shared = ring(links, nodes);
  assert.ok(shared?.clockwise);
  assert.deepEqual([shared.cx, shared.cy, shared.rx, shared.ry], [800, 520, 400, 240]);
  for (const link of links) {
    const from = nodes.find(node => node.id === link.from)!, to = nodes.find(node => node.id === link.to)!;
    const geometry = route(from, to, link, nodes, shared);
    assert.equal(geometry.route, 'ring');
    assert.ok(geometry.samples.every(([x, y]) => Math.abs(((x! - 800) / 400) ** 2 + ((y! - 520) / 240) ** 2 - 1) < 1e-9));
    assert.ok(geometry.samples.every(([x, y]) => nodes.every(node =>
      x! <= node.bounds.x || x! >= node.bounds.x + node.bounds.width || y! <= node.bounds.y || y! >= node.bounds.y + node.bounds.height)));
    const arrow = Math.hypot(geometry.tip[0]! - geometry.end[0]!, geometry.tip[1]! - geometry.end[1]!);
    assert.ok(arrow >= 20 && arrow < 22);
  }
});

test('aligned subjects connect with one straight line; offset subjects use a right-angled elbow around content', async () => {
  const { route } = await geometryContext();
  const link = { from: 'a', to: 'b', label: '', tone: 'teal' as const, style: 'solid' as const, reveal: 0 };
  const from = { id: 'a', bounds: { x: 100, y: 400, width: 160, height: 100 } };
  const to = { id: 'b', bounds: { x: 600, y: 400, width: 160, height: 100 } };
  const straight = route(from, to, link, [from, to]);
  assert.equal(straight.route, 'straight');
  assert.deepEqual([...straight.start], [274, 450]);
  assert.deepEqual([...straight.tip], [586, 450]);
  assert.deepEqual([...straight.end], [566, 450]);

  const far = { id: 'b', bounds: { x: 1200, y: 600, width: 160, height: 100 } };
  const obstacle = { id: 'middle', bounds: { x: 620, y: 350, width: 160, height: 200 } };
  const elbow = route(from, far, link, [from, far, obstacle]);
  assert.equal(elbow.route, 'elbow');
  assert.ok(elbow.samples.every(([x, y]) => x! < 604 || x! > 796 || y! < 334 || y! > 566));
  assert.ok(elbow.samples.every((point, index) => index === 0 || point[0] === elbow.samples[index - 1]![0] || point[1] === elbow.samples[index - 1]![1]));

  const anchor = { x: 136, y: 400, width: 88, height: 88 };
  const icon = { ...from, anchor, obstacles: [anchor] };
  const attached = route(icon, to, { ...link, fromPort: 'right', toPort: 'left' }, [icon, to]);
  assert.equal(attached.start[0], anchor.x + anchor.width + 14);
  assert.equal(attached.start[1], anchor.y + anchor.height / 2);
});

test('alignment snaps near-miss peers to shared centre lines and equal sizes without collapsing separations', async () => {
  const context = createContext({});
  runInContext((await readFile(join(__dirname, '../../assets/visuals.js'), 'utf8'))
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
  const align: typeof alignVisualNodes = context.alignVisualNodes;
  const node = (id: string, x: number, y: number, width: number, height: number) => ({ id, kind: 'panel' as const, x, y, width, height,
    label: id, detail: '', tone: 'blue' as const, icon: '' as const, reveal: 0 });
  const nodes = [node('a', 120, 400, 320, 140), node('b', 640, 418, 300, 150), node('c', 1140, 392, 320, 140)];
  const links = [{ from: 'a', to: 'b', label: '', tone: 'blue' as const, reveal: 0, style: 'solid' as const },
    { from: 'b', to: 'c', label: '', tone: 'blue' as const, reveal: 0, style: 'solid' as const }];
  const aligned = align(nodes, links);
  const centres = aligned.map(item => item.y + item.height / 2);
  assert.equal(new Set(centres).size, 1);
  assert.equal(new Set(aligned.map(item => `${item.width}x${item.height}`)).size, 1);
  const gaps = aligned.slice(1).map((item, index) => item.x - (aligned[index]!.x + aligned[index]!.width));
  assert.equal(new Set(gaps).size, 1);
  assert.ok(gaps[0]! >= 80);
  assert.equal(nodes[1]!.y, 418);

  const apart = align([node('top', 100, 400, 320, 140), node('below', 100, 560, 256, 112)]);
  assert.equal(apart[1]!.height, 112);
  assert.equal(apart[1]!.y - (apart[0]!.y + apart[0]!.height), 20);
  assert.equal(apart[0]!.x + apart[0]!.width / 2, apart[1]!.x + apart[1]!.width / 2);
});

const visualsContext = async () => {
  const context = createContext({});
  runInContext((await readFile(join(__dirname, '../../assets/visuals.js'), 'utf8'))
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
  return context;
};

test('offscreen and hidden visual surfaces pause motion without losing reveal state', async () => {
  const source = await readFile(join(__dirname, '../../assets/visuals.js'), 'utf8');
  assert.match(source, /document\.addEventListener\('visibilitychange'/);
  assert.match(source, /animation\.pause\(\)/);
  assert.match(source, /animation\.play\(\)/);
  assert.match(source, /visual-slide--motion-paused/);
  assert.match(source, /setReveals\(packet\.revealed, wantsMotion\)/);
});

test('build states accumulate in reveal order and are recomputed from the reveal count so rewinding restores them', async () => {
  const stateAt: typeof visualNodeState = (await visualsContext()).visualNodeState;
  const resting = { x: 100, y: 300, scale: 1, opacity: 1, focus: false };
  assert.deepEqual({ ...stateAt({ x: 100, y: 300 }, 9) }, resting);
  const node: Pick<VisualNode, 'x' | 'y' | 'states'> = { x: 100, y: 300, states: [
    { at: 2, x: 400, y: 320, focus: true },
    { at: 4, scale: 0.8, opacity: 0.5 },
    { at: 6, focus: false },
  ] };
  const at = (revealed: number) => ({ ...stateAt(node, revealed) });
  assert.deepEqual(at(0), resting);
  assert.deepEqual(at(1), resting);
  const moved = { x: 400, y: 320, scale: 1, opacity: 1, focus: true };
  assert.deepEqual(at(2), moved);
  assert.deepEqual(at(3), moved);
  const shrunk = { ...moved, scale: 0.8, opacity: 0.5 };
  assert.deepEqual(at(4), shrunk);
  assert.deepEqual(at(5), shrunk);
  assert.deepEqual(at(6), { ...shrunk, focus: false });
  assert.deepEqual(at(40), { ...shrunk, focus: false });
  assert.deepEqual(at(3), moved);
  assert.deepEqual(at(0), resting);
});

test('alignment treats roles as different subjects and leaves nodes whose states move them where they were authored', async () => {
  const align: typeof alignVisualNodes = (await visualsContext()).alignVisualNodes;
  const panel = (id: string, x: number, y: number, width: number, height: number): VisualNode => ({ id, kind: 'panel', x, y, width, height,
    label: id, detail: '', tone: 'blue', icon: '', reveal: 0 });
  const size = (node: VisualNode): string => `${node.width}x${node.height}`;
  const [first, second] = [panel('a', 120, 400, 320, 140), panel('b', 640, 418, 260, 120)] as [VisualNode, VisualNode];
  assert.deepEqual(Array.from(align([first, second]), size), ['320x144', '320x144']);
  assert.deepEqual(Array.from(align([{ ...first, role: 'hero' }, { ...second, role: 'secondary' }]), size), ['320x144', '256x128']);

  const trio = [first, panel('b', 640, 418, 300, 150), panel('c', 1140, 392, 320, 140)] as [VisualNode, VisualNode, VisualNode];
  const centreLines = (nodes: VisualNode[]): number => new Set(nodes.map(node => node.y + node.height / 2)).size;
  assert.equal(centreLines(align(trio)), 1);
  const moving = align([trio[0], trio[1], { ...trio[2], states: [{ at: 1, scale: 1.1 }] }]);
  assert.deepEqual({ x: moving[2]!.x, y: moving[2]!.y, width: moving[2]!.width, height: moving[2]!.height },
    { x: 1140, y: 392, width: 320, height: 140 });
  assert.equal(centreLines([moving[0]!, moving[1]!]), 1);
  assert.equal(centreLines(align([trio[0], trio[1], { ...trio[2], states: [{ at: 1, opacity: 0.4 }] }])), 1);
});

class FakeSvgElement {
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  children: FakeSvgElement[] = [];
  style = { transformOrigin: '', setProperty: (name: string, value: string): void => { this.properties.set(name, value); } };
  constructor(readonly name: string) {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(...children: FakeSvgElement[]): void { this.children.push(...children); }
}

test('every drawn graphic is plain bounded data that builds into inline svg with one entrance wrapper per part', async () => {
  const context = createContext({});
  const source = (await readFile(join(__dirname, '../../assets/visualAssets.js'), 'utf8')).replace(/^export /gm, '');
  const library = runInContext(`${source}\n;({ VISUAL_ASSETS, buildVisualAsset })`, context) as
    { VISUAL_ASSETS: typeof VISUAL_ASSETS; buildVisualAsset: typeof buildVisualAsset };
  const document = { createElementNS: (_namespace: string, name: string) => new FakeSvgElement(name) } as unknown as Document;
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const attributes: Record<string, string[]> = { rect: ['x', 'y', 'width', 'height', 'rx'], circle: ['cx', 'cy', 'r'],
    line: ['x1', 'y1', 'x2', 'y2'], path: ['d'], g: [] };
  const check = (id: string, part: VisualAssetPart): void => {
    const name = `${id} ${part.shape}`;
    assert.ok(Object.hasOwn(attributes, part.shape), `${name} is a known shape`);
    if (part.paint !== undefined) assert.ok(['solid', 'soft', 'line', 'ink', 'inkline', 'shade', 'tint'].includes(part.paint), `${name} paint`);
    if (part.tone !== undefined) assert.ok(['teal', 'blue', 'purple', 'neutral', 'warning', 'success', 'light'].includes(part.tone), `${name} tone`);
    if (part.w !== undefined) assert.ok(finite(part.w) && part.w > 0, `${name} stroke width`);
    if (part.draw) assert.ok(part.paint === 'line' || part.paint === 'inkline', `${name} only strokes draw on`);
    if (part.dash !== undefined) assert.equal(part.dash, 'dashes');
    if (part.motion === 'flow') assert.equal(part.dash, 'dashes', `${name} flows along a dashed stroke`);
    if (part.motion === 'spin' || part.motion === 'spin-reverse' || part.motion === 'twinkle') {
      assert.ok(part.shape === 'g' && part.origin?.length === 2 && part.origin.every(finite), `${name} turns about a drawn origin`);
    }
    if (part.shape === 'g') {
      assert.equal(part.attrs, undefined, `${name} carries no attributes`);
      assert.ok(part.parts && part.parts.length > 0, `${name} has parts`);
      for (const child of part.parts) check(id, child);
      return;
    }
    assert.equal(part.parts, undefined, `${name} has no children`);
    const given = Object.entries(part.attrs ?? {});
    assert.deepEqual(given.map(([key]) => key).filter(key => !attributes[part.shape]!.includes(key)), [], `${name} attribute names`);
    if (part.shape === 'path') assert.match(String(part.attrs?.d), /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/, `${name} path data`);
    else assert.ok(given.length > 0 && given.every(([, value]) => finite(value)), `${name} geometry`);
  };
  const walk = (element: FakeSvgElement): FakeSvgElement[] => [element, ...element.children.flatMap(walk)];

  const ids = Object.keys(library.VISUAL_ASSETS);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const spec = library.VISUAL_ASSETS[id as keyof typeof VISUAL_ASSETS];
    assert.ok(finite(spec.width) && spec.width > 0 && finite(spec.height) && spec.height > 0, `${id} drawing size`);
    assert.ok(spec.parts.length > 0, `${id} has parts`);
    for (const part of spec.parts) check(id, part);
    const svg = library.buildVisualAsset(document, id) as unknown as FakeSvgElement | null;
    assert.ok(svg, `${id} builds`);
    assert.equal(svg.name, 'svg');
    assert.equal(svg.attributes.get('viewBox'), `0 0 ${spec.width} ${spec.height}`);
    assert.equal(svg.attributes.get('aria-hidden'), 'true');
    assert.equal(svg.attributes.get('focusable'), 'false');
    assert.equal(svg.children.length, spec.parts.length);
    svg.children.forEach((entry, index) => {
      assert.equal(entry.attributes.get('class'), 'visual-asset__entry');
      assert.equal(entry.properties.get('--part-index'), String(index));
      assert.equal(entry.children.length, 1);
    });
    for (const element of walk(svg)) {
      assert.ok(['svg', 'g', 'rect', 'circle', 'line', 'path'].includes(element.name), `${id} draws only ${element.name}`);
      assert.deepEqual([...element.attributes.keys()].filter(key => /^on|href|^style$/i.test(key)), [], `${id} ${element.name} markup`);
    }
  }
  for (const id of ['unknown', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(library.buildVisualAsset(document, id), null, id);
});

class FixtureElement {
  children: FixtureElement[] = [];
  classes = new Set<string>();
  className = '';
  hidden = false;
  muted = false;
  autoplay = false;
  playsInline = false;
  textContent = '';
  srcObject: unknown = null;
  classList = {
    add: (value: string): void => { this.classes.add(value); },
    remove: (value: string): void => { this.classes.delete(value); },
    toggle: (value: string, active: boolean): void => { if (active) this.classes.add(value); else this.classes.delete(value); },
  };
  append(...children: FixtureElement[]): void { this.children.push(...children); }
  setAttribute(): void {}
  pause(): void {}
  async play(): Promise<void> {}
  remove(): void {}
}

function cameraStream() {
  const track = { stops: 0, onended: null as (() => void) | null, stop(): void { this.stops++; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
async function cameraFixture(capture = true) {
  const requests: { constraints: MediaStreamConstraints; resolve: (stream: ReturnType<typeof cameraStream>) => void; reject: (error: unknown) => void }[] = [];
  const reports: VisualVideoState[] = [];
  const document = { createElement: () => new FixtureElement(), defaultView: { navigator: { mediaDevices: {
    getUserMedia: (constraints: MediaStreamConstraints) => new Promise<ReturnType<typeof cameraStream>>((resolve, reject) => {
      requests.push({ constraints, resolve, reject });
    }),
  } } } };
  const host = Object.assign(new FixtureElement(), { ownerDocument: document });
  const context = createContext({ host, capture, report: (state: VisualVideoState) => { reports.push(state); } });
  runInContext((await readFile(join(__dirname, '../../assets/visualVideo.js'), 'utf8')).replace(/^export /gm, '')
    + '\ncontroller = createPresenterVideo(host, { capture, report });', context);
  const controller: ReturnType<typeof createPresenterVideo> = context.controller;
  const slot = host.children[0]!;
  return { controller, requests, reports, slot, video: slot.children[1]! };
}
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const cameraRequest = (requestId = 'manual-request'): VisualVideoState =>
  ({ mode: 'camera', status: 'waiting', error: null, requestId });

test('preview never captures; audience camera is video-only and releases tracks on Off', async () => {
  const preview = await cameraFixture(false);
  preview.controller.update(true, cameraRequest());
  assert.equal(preview.requests.length, 0);
  preview.controller.dispose();
  const fixture = await cameraFixture();
  fixture.controller.update(true, { mode: 'guide', status: 'idle', error: null, requestId: '' });
  assert.equal(fixture.requests.length, 0);
  fixture.controller.update(true, cameraRequest());
  assert.equal(fixture.requests[0]?.constraints.audio, false);
  assert.equal(fixture.video.muted, true);
  const stream = cameraStream();
  fixture.requests[0]!.resolve(stream);
  await settle();
  assert.equal(fixture.reports.at(-1)?.status, 'active');
  assert.equal(fixture.video.srcObject, stream);
  fixture.controller.update(true, { mode: 'off', status: 'idle', error: null, requestId: 'off' });
  assert.equal(stream.track.stops, 1);
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.slot.hidden, true);
  fixture.controller.dispose();
});

test('permission granted after Off releases the late stream without claiming active capture', async () => {
  const fixture = await cameraFixture();
  fixture.controller.update(true, cameraRequest());
  fixture.controller.update(true, { mode: 'off', status: 'idle', error: null, requestId: 'off' });
  const stream = cameraStream();
  fixture.requests[0]!.resolve(stream);
  await settle();
  assert.equal(stream.track.stops, 1);
  assert.equal(fixture.reports.some(report => report.status === 'active'), false);
  fixture.controller.dispose();
});

test('obsolete permission failure cannot stop a newer camera; disconnect stops capture without automatic retry', async () => {
  const fixture = await cameraFixture();
  fixture.controller.update(true, cameraRequest('old'));
  fixture.controller.update(true, cameraRequest('new'));
  const stream = cameraStream();
  fixture.requests[1]!.resolve(stream);
  await settle();
  fixture.requests[0]!.reject({ name: 'NotReadableError' });
  await settle();
  assert.equal(stream.track.stops, 0);
  assert.equal(fixture.reports.at(-1)?.status, 'active');
  assert.equal(fixture.reports.at(-1)?.requestId, 'new');
  fixture.controller.disconnect('Disconnected');
  assert.equal(stream.track.stops, 1);
  fixture.controller.update(true, { ...cameraRequest('new'), status: 'active' });
  assert.equal(fixture.requests.length, 2);
  fixture.controller.dispose();
});

test('permission denial and a camera busy in another app surface actionable errors', async () => {
  for (const [name, message] of [['NotAllowedError', /permission was denied/], ['NotReadableError', /Teams\/Riverside/]] as const) {
    const fixture = await cameraFixture();
    fixture.controller.update(true, cameraRequest());
    fixture.requests[0]!.reject({ name });
    await settle();
    assert.equal(fixture.reports.at(-1)?.status, 'error');
    assert.match(fixture.reports.at(-1)?.error ?? '', message);
    fixture.controller.dispose();
  }
});
