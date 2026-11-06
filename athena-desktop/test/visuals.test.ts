import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { connectionGeometry, connectionRing } from '../assets/visualGeometry';
import type { createPresenterVideo } from '../assets/visualVideo';
import type { VisualVideoState } from '../assets/visualComposition';
import type { alignVisualNodes, visualBuildSteps } from '../assets/visuals';

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

test('closing logo uses the official reversed white artwork with no background and is strictly opt-in', async () => {
  const source = await readFile(join(__dirname, '../../assets/visuals.js'), 'utf8');
  const children: Array<{ className?: string; alt?: string; src?: string }> = [];
  const layer = { classList: { add() {} }, append(...items: typeof children) { children.push(...items); } };
  const context = createContext({ layer, html: (_tag: string, className: string) => ({
    className, append() {},
  }), emphasised: () => ({}), setCloseMarks() {} });
  runInContext(source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
  const start = source.indexOf('  function closeScene(');
  const end = source.indexOf('  function illustration(', start);
  runInContext(source.slice(start, end), context);
  const scene = { title: 'Put your strategy to work', subtitle: '', items: [] };
  context.closeScene(scene, 0);
  assert.equal(children.length, 1);
  children.length = 0;
  context.closeScene({ ...scene, brandMark: 'ibm-8bar' }, 0);
  const logo = children.find(child => child.className === 'slide-close__brand');
  assert.equal(logo?.alt, 'IBM eight-bar logo');
  const svg = decodeURIComponent(logo!.src!.replace('data:image/svg+xml,', ''));
  assert.match(svg, /viewBox="57.6 61.7 1109.6 440.2" fill="#ffffff"/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 17);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject|style=|background|<text/);
  assert.match(svg, /M304.2,473.9v28h227c29.1,0,55.8-10.6,76.2-28H304.2z/);
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
