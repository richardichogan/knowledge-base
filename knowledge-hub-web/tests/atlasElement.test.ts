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
  alphaTarget: number; dragging: boolean; path: string[]; cv: Canvas; w: number; h: number;
  connectedCallback(): void; disconnectedCallback(): void; tick(): void; draw(now: number): void; cmd(c: string): void;
  attributeChangedCallback(name: string, before: string | null, value: string): void;
  S(n: Node): [number, number]; world(p: [number, number]): [number, number]; isVis(n: Node): boolean;
};
class Canvas {
  width = 0; height = 0; style: Record<string, string> = {};
  events = new Map<string, Handler>();
  calls: string[] = [];
  context = new Proxy({ measureText: (text: string) => ({ width: text.length * 7 }) }, {
    get: (target, name) => name in target ? target[name as keyof typeof target] : (..._args: unknown[]) => { this.calls.push(String(name)); },
    set: () => true,
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
