import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { AtlasData } from '../src/components/graph/atlasData';

type Node = { id: string; x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null };
type Handler = (event: { type?: string; pointerId: number; clientX: number; clientY: number; button?: number; deltaY?: number; preventDefault(): void }) => void;
type Element = {
  isConnected: boolean; data: AtlasData; nodes: Node[]; edges: unknown[];
  cam: { x: number; y: number; k: number }; camT: unknown; reduced: boolean; autoFit: number;
  alphaTarget: number; dragging: boolean; path: string[]; cv: Canvas; w: number; h: number; time: number; hover: Node | null;
  connectedCallback(): void; disconnectedCallback(): void; tick(): void; draw(now: number): void; cmd(c: string): void;
  attributeChangedCallback(name: string, before: string | null, value: string): void;
  S(n: Node): [number, number]; world(p: [number, number]): [number, number]; isVis(n: Node): boolean;
};
class Canvas {
  width = 0; height = 0; style: Record<string, string> = {};
  title = '';
  events = new Map<string, Handler>();
  calls: string[] = [];
  text: Array<{ text: string; x: number; y: number; width: number; font: string }> = [];
  fills: Array<{ x: number; y: number; width: number; height: number }> = [];
  context = new Proxy({
    font: '',
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillText: (text: string, x: number, y: number) => { this.text.push({ text, x, y, width: text.length * 7, font: this.context.font }); },
    fillRect: (x: number, y: number, width: number, height: number) => { this.fills.push({ x, y, width, height }); },
  }, {
    get: (target, name) => name in target ? target[name as keyof typeof target] : (..._args: unknown[]) => { this.calls.push(String(name)); },
    set: (target, name, value) => Reflect.set(target, name, value),
  });
  getContext(): object { return this.context; }
  addEventListener(name: string, handler: Handler): void { this.events.set(name, handler); }
  setPointerCapture(): void {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
}
const payload: AtlasData = {
  types: { project: { label: 'Projects', one: 'Project', color: '#08bdba' }, note: { label: 'Notes', one: 'Note', color: '#78a9ff' } },
  nodes: [
    { id: 'p', name: 'Project', type: 'project', hub: true, project: 'p', last: 0, island: -1 },
    { id: 'a', name: 'First', type: 'note', hub: false, project: 'p', last: 1, island: -1 },
    { id: 'b', name: 'Second', type: 'note', hub: false, project: 'p', last: 20, island: -1 },
  ], edges: [{ id: 'pa', a: 'p', b: 'a', rel: 'belongs to', kind: 'member', inferred: false },
    { id: 'ab', a: 'a', b: 'b', rel: 'references', kind: 'internal', inferred: false }], islandCount: 0,
};
function harness(reduced = false) {
  let time = 10, sequence = 0;
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  const events = new Map<string, () => void>(), mediaEvents = new Map<string, () => void>();
  const emitted: Array<{ detail: { id: string | null } }> = [];
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const media = { matches: reduced, addEventListener: (n: string, cb: () => void) => { mediaEvents.set(n, cb); }, removeEventListener: (n: string) => { mediaEvents.delete(n); } };
  const document = { hidden: false, createElement: () => new Canvas(), addEventListener: (n: string, cb: () => void) => { events.set(n, cb); }, removeEventListener: (n: string) => { events.delete(n); } };
  let Constructor: (new () => Element) | undefined;
  runInNewContext(readFileSync(new URL('../public/athena/atlas-graph.js', import.meta.url), 'utf8'), {
    HTMLElement: class {
      isConnected = false;
      attachShadow() { const canvas = new Canvas(); return { innerHTML: '', querySelector: () => canvas }; }
      getBoundingClientRect() { return { width: 800, height: 600 }; }
      dispatchEvent(event: typeof emitted[number]) { emitted.push(event); }
    },
    window: { matchMedia: () => media, devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} },
    document, performance: { now: () => time },
    getComputedStyle: () => ({ getPropertyValue: () => '#262626' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      constructor(callback: typeof observers[number]) { observers.push(callback); }
      observe() {} disconnect() {}
    },
    CustomEvent: class { constructor(public name: string, public options: typeof emitted[number]) { Object.assign(this, options); } },
    customElements: { get: () => undefined, define: (_name: string, constructor: new () => Element) => { Constructor = constructor; } },
    requestAnimationFrame: (cb: () => void) => { frames.set(++sequence, cb); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    setTimeout: (cb: () => void) => { timers.set(++sequence, cb); return sequence; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  assert.ok(Constructor);
  const make = (): Element => { const el = new Constructor!(); el.data = payload; el.isConnected = true; el.connectedCallback(); return el; };
  return {
    make, frames, timers, emitted, document,
    step() { time += 16; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); },
    hidden(value: boolean) { document.hidden = value; events.get('visibilitychange')?.(); },
    offscreen(value: boolean) { observers.forEach(cb => cb([{ isIntersecting: !value }])); },
    motion(value: boolean) { media.matches = value; mediaEvents.get('change')?.(); },
  };
}
function pointer(el: Element, type: string, x: number, y: number, pointerId = 1) {
  el.cv.events.get(type)?.({ type, pointerId, clientX: x, clientY: y, button: 0, preventDefault() {} });
}

test('property data connects without global demo data; seeds and reflow are deterministic per instance', () => {
  const h = harness(), a = h.make(), b = h.make();
  const coords = (el: Element) => JSON.stringify(el.nodes.map(n => [n.x, n.y]));
  assert.equal(coords(a), coords(b));
  const initial = coords(a); a.tick(); assert.notEqual(coords(a), initial);
  a.cmd('reflow'); assert.equal(coords(a), initial);
  assert.equal(a.cv.width, 1600);
  a.draw(1000); assert.ok(a.cv.calls.includes('quadraticCurveTo'));
  a.disconnectedCallback(); b.disconnectedCallback();
  assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
});

test('force dragging raises heat, moves neighbours and releases without stale pins or a selection click', () => {
  const h = harness(), el = h.make(), dragged = el.nodes[1]!, other = el.nodes[2]!;
  const [x, y] = el.S(dragged), before = [other.x, other.y];
  pointer(el, 'pointerdown', x, y); pointer(el, 'pointermove', x + 150, y + 40);
  assert.equal(el.alphaTarget, 0.3); assert.equal(el.dragging, true); assert.notEqual(dragged.fx, null);
  for (let i = 0; i < 10; i++) el.tick();
  assert.notDeepEqual([other.x, other.y], before);
  pointer(el, 'pointerup', x + 150, y + 40);
  assert.equal(dragged.fx, null); assert.equal(el.alphaTarget, 0.04); assert.equal(el.dragging, false);
  assert.equal(h.emitted.length, 0);
  el.disconnectedCallback();
});

test('click selects, cancellation never selects; wheel preserves cursor world coordinate', () => {
  const h = harness(), el = h.make(), [x, y] = el.S(el.nodes[1]!);
  pointer(el, 'pointerdown', x, y); pointer(el, 'pointerup', x, y);
  assert.equal(h.emitted[0]?.detail.id, 'a');
  pointer(el, 'pointerdown', x, y); pointer(el, 'pointercancel', x, y);
  assert.equal(h.emitted.length, 1);
  const before = el.world([300, 200]);
  el.cv.events.get('wheel')?.({ pointerId: 0, clientX: 300, clientY: 200, deltaY: -100, preventDefault() {} });
  const after = el.world([300, 200]);
  assert.ok(Math.hypot(before[0] - after[0], before[1] - after[1]) < 1e-8);
  el.disconnectedCallback();
});

test('scoped root stays centred, reduced motion draws path immediately and does not spin a timer', () => {
  const h = harness(true), el = h.make();
  el.attributeChangedCallback('scope', null, 'a');
  assert.equal(el.nodes.find(n => n.id === 'a')?.x, 0);
  el.attributeChangedCallback('path', null, 'a,b');
  el.cv.calls = []; el.draw(10);
  assert.ok(el.cv.calls.includes('lineTo'));
  el.cmd('in'); assert.equal(el.camT, null);
  h.step(); assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  el.disconnectedCallback();
});

test('hidden and offscreen instances pause both frame and fallback loops and resume safely', () => {
  const h = harness(), el = h.make();
  assert.equal(h.frames.size, 1); assert.equal(h.timers.size, 1);
  h.hidden(true); assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  h.hidden(false); h.step(); assert.equal(h.frames.size, 1);
  h.offscreen(true); assert.equal(h.frames.size, 0); assert.equal(h.timers.size, 0);
  h.offscreen(false); h.step(); assert.equal(h.frames.size, 1);
  h.motion(true); h.step(); assert.equal(h.frames.size, 0);
  el.disconnectedCallback();
});

test('type-hidden connected context remains visible; each graph owns its camera commands', () => {
  const h = harness(), a = h.make(), b = h.make();
  a.attributeChangedCallback('hide-types', null, 'note');
  assert.equal(a.isVis(a.nodes[1]!), false);
  a.attributeChangedCallback('context', null, 'a');
  assert.equal(a.isVis(a.nodes[1]!), true);
  b.autoFit = 0;
  const initial = { ...b.cam };
  a.cmd('in'); h.step(); assert.deepEqual({ ...b.cam }, initial);
  a.disconnectedCallback(); b.disconnectedCallback();
});

test('dense compact labels fit without overlaps or duplicate hub titles, retaining every record and edge', () => {
  const h = harness(), el = h.make();
  const records = Array.from({ length: 80 }, (_, i) => ({
    ...payload.nodes[1]!, id: `note-${i}`, name: `Delivery ${i}: weekly alignment, architecture decisions and programme follow-up notes`,
  }));
  const data: AtlasData = {
    ...payload,
    nodes: [...payload.nodes, ...records],
    edges: [...payload.edges, ...records.map(n => ({
      ...payload.edges[1]!, id: `a/${n.id}`, a: 'a', b: n.id,
    }))],
  };
  data.nodes[1] = { ...data.nodes[1]!, name: 'Root: STP/RTR weekly delivery alignment and decisions for the entire programme' };
  el.data = data;
  el.attributeChangedCallback('compact', null, '');
  el.attributeChangedCallback('scope', null, 'a');
  el.attributeChangedCallback('selected', null, 'a');
  el.time = 10;
  el.h = 300;
  const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a): boolean =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  for (const width of [280, 360, 640]) {
    el.w = width;
    el.cam = { x: 0, y: 0, k: 1 };
    el.nodes.forEach((n, i) => { n.x = i === 1 ? 0 : (i % 7 - 3) * 8; n.y = i === 1 ? 0 : (i % 5 - 2) * 8; });
    el.hover = el.nodes.find(n => n.id === 'note-0')!;
    el.hover.y = 70;
    el.cv.text = [];
    el.draw(1000);
    assert.equal(el.nodes.length, data.nodes.length);
    assert.equal(el.edges.length, data.edges.length);
    const labels = el.cv.text;
    assert.ok(labels.length >= 2 && labels.length <= 4);
    assert.ok(labels[0]?.text.startsWith('Root:'));
    assert.ok(labels.some(label => label.text.startsWith('Delivery 0:')));
    assert.ok(labels[0]?.text.endsWith('…'));
    assert.equal(new Set(labels.map(label => label.text)).size, labels.length);
    const boxes = [{ left: width - 64, top: el.h - 170, right: width, bottom: el.h }];
    for (const label of labels) {
      const box = { left: label.x - 4, top: label.y - 15, right: label.x + label.width + 4, bottom: label.y + 6 };
      assert.ok(label.width <= 220);
      assert.ok(box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= el.h);
      assert.ok(boxes.every(other => !overlaps(box, other)), `Overlapping compact title at ${width}px: ${label.text}`);
      boxes.push(box);
    }
  }
  el.disconnectedCallback();
});

test('hover exposes the full title and clears it when leaving or reflowing', () => {
  const h = harness(), el = h.make();
  const [x, y] = el.S(el.nodes[1]!);
  pointer(el, 'pointermove', x, y);
  assert.equal(el.cv.title, 'First');
  pointer(el, 'pointerleave', x, y);
  assert.equal(el.cv.title, '');
  pointer(el, 'pointermove', x, y);
  el.cmd('reflow');
  assert.equal(el.cv.title, '');
  el.disconnectedCallback();
});

test('full graph limits dense selection, search and zoom labels without hiding records or overlapping titles', () => {
  const h = harness(true), el = h.make();
  const records = Array.from({ length: 80 }, (_, i) => ({
    ...payload.nodes[1]!, id: `note-${i}`, name: `Delivery ${i}: weekly alignment, architecture decisions and programme follow-up notes`,
  }));
  const data: AtlasData = {
    ...payload,
    nodes: [...payload.nodes, ...records],
    edges: [...payload.edges, ...records.map(n => ({ ...payload.edges[1]!, id: `a/${n.id}`, a: 'a', b: n.id }))],
  };
  el.data = data;
  el.time = 10;
  el.h = 600;
  for (const width of [480, 1040]) {
    el.w = width;
    el.nodes.forEach((n, i) => { n.x = (i % 9 - 4) * 34; n.y = (Math.floor(i / 9) - 4) * 30; });
    el.nodes[1]!.x = -80; el.nodes[1]!.y = -130;
    el.nodes[3]!.x = 80; el.nodes[3]!.y = -130;
    el.hover = el.nodes[3]!;
    el.attributeChangedCallback('selected', null, 'a');
    for (const mode of ['selection', 'search', 'path', 'zoom']) {
      el.attributeChangedCallback('search', null, mode === 'search' ? 'Delivery' : '');
      el.attributeChangedCallback('path', null, mode === 'path' ? records.slice(0, 20).map(n => n.id).join(',') : '');
      el.cam = { x: 0, y: 0, k: mode === 'zoom' ? 1.8 : 1 };
      el.cv.text = []; el.cv.calls = [];
      el.draw(1000);
      assert.equal(el.nodes.length, data.nodes.length);
      assert.equal(el.edges.length, data.edges.length);
      const labels = el.cv.text;
      assert.ok(labels.length >= 2 && labels.length <= 6, `${mode}: capped title count`);
      assert.ok(labels.some(label => label.text === 'First'), 'Selected title stays visible');
      assert.ok(labels.some(label => label.text.startsWith('Delivery 0:') && label.text.endsWith('…')), 'Hovered title is prioritised and shortened');
      assert.equal(new Set(labels.map(label => label.text)).size, labels.length);
      assert.ok(!el.cv.calls.includes('strokeText'), 'No heavy text outlines or secondary metadata');
      const boxes = [{ left: width - 64, top: el.h - 170, right: width, bottom: el.h }];
      for (const label of labels) {
        const box = { left: label.x - 4, top: label.y - 15, right: label.x + label.width + 4, bottom: label.y + 6 };
        assert.ok(label.width <= 220);
        assert.match(label.font, /^400 12px/);
        assert.ok(box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= el.h);
        assert.ok(boxes.every(other => box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom),
          `${mode}: title overlaps at ${width}px`);
        boxes.push(box);
      }
    }
  }
  el.disconnectedCallback();
});

test('identical graph refreshes do not restart entry, force positions or camera; changed data and Reflow still rebuild', () => {
  const h = harness(), el = h.make();
  el.attributeChangedCallback('compact', null, '');
  el.attributeChangedCallback('scope', null, 'a');
  el.tick();
  el.time = 8;
  el.cam = { x: 12, y: 8, k: 1.8 };
  const nodes = el.nodes, edges = el.edges, camera = el.cam;
  const positions = JSON.stringify(el.nodes);
  el.data = payload;
  el.data = structuredClone(payload);
  assert.equal(el.nodes, nodes);
  assert.equal(el.edges, edges);
  assert.equal(el.time, 8);
  assert.equal(el.cam, camera);
  assert.equal(JSON.stringify(el.nodes), positions);
  const changed = structuredClone(payload);
  changed.edges.push({ ...changed.edges[0]!, id: 'pb', a: 'p', b: 'b' });
  el.data = changed;
  assert.notEqual(el.nodes, nodes);
  assert.equal(el.edges.length, 3);
  assert.equal(el.time, 0);
  const refreshed = el.nodes;
  el.cmd('reflow');
  assert.notEqual(el.nodes, refreshed);
  el.disconnectedCallback();
});

test('high-degree note neighbourhoods stay bounded instead of launching nodes off screen', () => {
  const h = harness(), el = h.make();
  const notes = Array.from({ length: 200 }, (_, i) => ({ ...payload.nodes[1]!, id: `dense-${i}`, name: `Linked record ${i}` }));
  el.data = { ...payload, nodes: [payload.nodes[0]!, ...notes], edges: notes.map(n => ({
    ...payload.edges[0]!, id: `p/${n.id}`, a: 'p', b: n.id,
  })) };
  el.attributeChangedCallback('compact', null, '');
  el.attributeChangedCallback('scope', null, 'dense-0');
  for (let i = 0; i < 320; i++) {
    el.tick();
    assert.ok(el.nodes.every(n => Number.isFinite(n.x + n.y) && Math.hypot(n.x, n.y) < 2000), `Layout escaped at tick ${i}`);
  }
  assert.equal(el.nodes.length, 201);
  assert.equal(el.edges.length, 200);
  el.disconnectedCallback();
});

test('only compact graphs clear to transparent and draw light labels without black outlines', () => {
  const h = harness(true), el = h.make();
  el.cv.fills = [];
  el.draw(1000);
  assert.ok(el.cv.fills.some(r => r.width === el.w && r.height === el.h), 'Full Atlas keeps its painted background');
  el.attributeChangedCallback('compact', null, '');
  el.attributeChangedCallback('scope', null, 'a');
  el.cv.fills = []; el.cv.calls = []; el.cv.text = [];
  el.draw(1000);
  assert.ok(el.cv.calls.includes('clearRect'));
  assert.ok(!el.cv.fills.some(r => r.width === el.w && r.height === el.h));
  assert.ok(!el.cv.calls.includes('strokeText'));
  assert.ok(el.cv.text.length > 0);
  assert.ok(el.cv.text.every(label => label.font.startsWith('400 12px')));
  el.disconnectedCallback();
});
