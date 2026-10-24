import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

class Canvas {
  width = 0; height = 0; strokes = 0; signature = 0; style: Record<string, string> = {};
  strokeWidths = new Set<number>();
  peakAlpha = 0;
  context = {
    lineWidth: 0,
    strokeStyle: '',
    clearRect: () => { this.strokes = 0; this.signature = 0; this.strokeWidths.clear(); this.peakAlpha = 0; },
    setTransform() {}, drawImage() {}, beginPath() {},
    moveTo: (x: number, y: number) => { assert.ok(Number.isFinite(x + y)); this.signature += x + y; },
    lineTo: (x: number, y: number) => { assert.ok(Number.isFinite(x + y)); this.signature += x * 0.7 + y; },
    stroke: () => {
      this.strokes++; this.strokeWidths.add(this.context.lineWidth);
      this.peakAlpha = Math.max(this.peakAlpha, Number(this.context.strokeStyle.split(',').at(-1)?.replace(')', '')));
    },
  };
  getContext() { return this.context; }
}
const observed = new Set(['mood', 'state', 'size', 'label', 'still', 'paused', 'interaction']);
class Host {
  attrs = new Map<string, string>();
  isConnected = false;
  canvas = new Canvas(); glow = new Canvas();
  sphere = { style: {} }; live = { textContent: '' }; events: Array<{ detail: { from: string; to: string } }> = [];
  shadowRoot = { innerHTML: '', querySelector: (s: string) => s === '.main' ? this.canvas : s === '.glow' ? this.glow : s === '.sph' ? this.sphere : this.live };
  attachShadow() { return this.shadowRoot; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttribute(name: string, value: string) {
    const old = this.getAttribute(name);
    this.attrs.set(name, String(value));
    if (observed.has(name)) (this as Ribbon).attributeChangedCallback(name, old, String(value));
  }
  removeAttribute(name: string) {
    const old = this.getAttribute(name); this.attrs.delete(name);
    if (observed.has(name)) (this as Ribbon).attributeChangedCallback(name, old, null);
  }
  dispatchEvent(event: Host['events'][number]) { this.events.push(event); return true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 240, height: 240 }; }
}
type Ribbon = Host & {
  connectedCallback(): void; disconnectedCallback(): void;
  attributeChangedCallback(name: string, old: string | null, value: string | null): void;
  mood: string; level: number | null; _p: Record<string, number>; _yaw: number; _spin: number; _energy: number;
};

function fixture(attrs: Record<string, string> = {}) {
  let now = 100, sequence = 0, Constructor: (new () => Ribbon) | undefined;
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  const events = new Map<string, () => void>(), mediaEvents = new Map<string, () => void>();
  let intersect: (es: Array<{ isIntersecting: boolean }>) => void = () => {};
  const document = { hidden: false,
    addEventListener: (n: string, f: () => void) => { events.set(n, f); },
    removeEventListener: (n: string) => { events.delete(n); } };
  const media = { matches: false,
    addEventListener: (n: string, f: () => void) => { mediaEvents.set(n, f); },
    removeEventListener: (n: string) => { mediaEvents.delete(n); } };
  runInNewContext(readFileSync(new URL('../public/athena/athena-ribbon.js', import.meta.url), 'utf8'), {
    HTMLElement: Host, performance: { now: () => now }, document, devicePixelRatio: 3,
    matchMedia: () => media, addEventListener() {},
    requestAnimationFrame: (f: () => void) => { frames.set(++sequence, f); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    setTimeout: (f: () => void) => { timers.set(++sequence, f); return sequence; },
    clearTimeout: (id: number) => { timers.delete(id); },
    customElements: { get: () => undefined, define: (_n: string, c: new () => Ribbon) => { Constructor = c; } },
    CustomEvent: class { detail: unknown; constructor(_n: string, options: { detail: unknown }) { this.detail = options.detail; } },
    IntersectionObserver: class {
      constructor(f: typeof intersect) { intersect = f; }
      observe() {} disconnect() {}
    },
  });
  assert.ok(Constructor);
  const ribbon = new Constructor();
  for (const [key, value] of Object.entries(attrs)) ribbon.setAttribute(key, value);
  ribbon.isConnected = true; ribbon.connectedCallback();
  const step = (ms = 16, fallback = false): void => {
    now += ms;
    for (const callback of [...(fallback ? timers : frames).values()]) callback();
  };
  return { ribbon, frames, timers, events, mediaEvents, step,
    advance(ms: number) { for (let t = 0; t < ms; t += 16) step(); },
    hidden(value: boolean) { document.hidden = value; events.get('visibilitychange')?.(); },
    visible(value: boolean) { intersect([{ isIntersecting: value }]); },
    reduced(value: boolean) { media.matches = value; mediaEvents.get('change')?.(); },
  };
}

test('actual renderer draws additive strands at supplied size thresholds and caps DPR at two', () => {
  for (const [size, strokes] of [[32, 90], [96, 330], [240, 540]]) {
    const f = fixture({ size: String(size) });
    f.step();
    assert.equal(f.ribbon.canvas.strokes, strokes);
    assert.equal(f.ribbon.canvas.width, size! * 2);
    assert.equal(f.ribbon.getAttribute('role'), 'img');
    const before = f.ribbon.canvas.signature;
    f.step();
    assert.notEqual(f.ribbon.canvas.signature, before);
  }
});

test('moods ease from the current shape with the original 380ms time constant and preserve phases', () => {
  const f = fixture();
  f.step();
  const yaw = f.ribbon._yaw, spin = f.ribbon._spin;
  f.ribbon.mood = 'thinking';
  assert.equal(f.ribbon._p.twist, 1);
  f.step(16);
  assert.ok(Math.abs(f.ribbon._p.twist! - (1 + 2 * (1 - Math.exp(-0.016 / 0.38)))) < 1e-10);
  assert.ok(f.ribbon._yaw > yaw && f.ribbon._spin > spin);
  const current = f.ribbon._p.twist;
  f.ribbon.mood = 'sorry';
  assert.equal(f.ribbon._p.twist, current);
  f.advance(4000);
  assert.ok(Math.abs(f.ribbon._p.bright! - 0.5) < 0.001);
  assert.equal(f.ribbon.getAttribute('aria-label'), 'Athena is sorry');
});

test('small chat ribbons use thicker strands without changing their size or mood geometry', () => {
  const f = fixture({ size: '44', still: '' });
  f.step();
  assert.deepEqual([...f.ribbon.canvas.strokeWidths].sort(), [0.75, 1]);
  assert.equal(f.ribbon.canvas.width, 88);
  assert.equal(f.ribbon._p.bright, 0.85);
  assert.ok(f.ribbon.canvas.peakAlpha >= 0.6, 'Resting chat icon must have visibly bright edge strands');
});

test('all nine settled moods render once, remain finite and announce only supported non-silent events', () => {
  const expected = { resting: 0.85, listening: 1.25, thinking: 1.15, answering: 1.35, happy: 1.35, curious: 1.1, unsure: 0.8, sorry: 0.5, excited: 1.7 };
  const f = fixture({ still: '', size: '140' });
  for (const [mood, bright] of Object.entries(expected)) {
    f.ribbon.mood = mood; f.step();
    assert.equal(f.ribbon._p.bright, bright);
    assert.equal(f.ribbon.canvas.strokes, 540);
    assert.equal(f.frames.size + f.timers.size, 0);
  }
  f.ribbon.mood = 'sorry'; f.step();
  assert.equal(f.ribbon.live.textContent, 'Athena is sorry');
  f.ribbon.setAttribute('silent', '');
  f.ribbon.mood = 'thinking';
  assert.equal(f.ribbon.live.textContent, 'Athena is sorry');
  assert.equal(f.ribbon.events.at(-1)?.detail.to, 'thinking');
  f.ribbon.mood = 'constructor';
  assert.equal(f.ribbon.mood, 'resting');
});

test('hidden, offscreen and explicitly paused ribbons cancel both RAF and timer; detach cleans listeners', () => {
  const f = fixture(); f.step();
  assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1);
  f.hidden(true);
  assert.equal(f.frames.size + f.timers.size, 0);
  f.ribbon.mood = 'thinking';
  assert.equal(f.frames.size + f.timers.size, 0);
  f.hidden(false); f.step(40, true);
  assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1);
  f.visible(false);
  assert.equal(f.frames.size + f.timers.size, 0);
  f.visible(true); f.ribbon.setAttribute('paused', '');
  assert.equal(f.frames.size + f.timers.size, 0);
  f.ribbon.removeAttribute('paused'); f.step();
  f.ribbon.isConnected = false; f.ribbon.disconnectedCallback();
  assert.equal(f.frames.size + f.timers.size + f.events.size + f.mediaEvents.size, 0);
});

test('reduced motion freezes oscillators, settles changed shapes and stops repainting', () => {
  const f = fixture({ track: '' }); f.step();
  f.reduced(true); f.ribbon.mood = 'excited';
  const yaw = f.ribbon._yaw, spin = f.ribbon._spin;
  f.advance(5000);
  assert.equal(f.ribbon._yaw, yaw); assert.equal(f.ribbon._spin, spin);
  assert.equal(f.frames.size + f.timers.size, 0);
  const frame = f.ribbon.canvas.signature;
  f.advance(1000);
  assert.equal(f.ribbon.canvas.signature, frame);
  f.ribbon.mood = 'sorry'; f.advance(5000);
  assert.notEqual(f.ribbon.canvas.signature, frame);
  assert.equal(f.frames.size + f.timers.size, 0);
  f.reduced(false); f.step();
  assert.equal(f.frames.size, 1);
});

test('real mic level clamps and changes only listening ripple without synthetic input levels', () => {
  const f = fixture({ mood: 'listening', still: '' });
  f.ribbon.level = 0; f.step();
  const quiet = f.ribbon.canvas.signature;
  f.ribbon.level = 2; f.ribbon.setAttribute('size', '240'); f.step();
  assert.equal(f.ribbon.level, 1);
  assert.notEqual(f.ribbon.canvas.signature, quiet);
  f.ribbon.level = null;
  assert.equal(f.ribbon.level, null);
});

test('composer typing eases into an attentive tilt and relaxes without resizing or restarting phases', () => {
  const f = fixture({ size: '56', mood: 'listening', interaction: 'typing' });
  f.advance(3000);
  assert.ok(Math.abs(f.ribbon._p.roll! + 0.35) < 0.001);
  assert.ok(Math.abs(f.ribbon._p.bright! - 1.5) < 0.001);
  assert.equal(f.ribbon.canvas.width, 112);
  const yaw = f.ribbon._yaw;
  f.ribbon.setAttribute('interaction', 'idle');
  f.ribbon.mood = 'resting';
  f.advance(3000);
  assert.ok(Math.abs(f.ribbon._p.roll! - 0.3) < 0.001);
  assert.ok(f.ribbon._yaw > yaw);
  assert.equal(f.ribbon.canvas.width, 112);
});

test('voice energy opens and brightens strands with bounded attack/release and no invented speech', () => {
  const quiet = fixture({ size: '96', mood: 'listening', interaction: 'voice' });
  const voice = fixture({ size: '96', mood: 'listening', interaction: 'voice' });
  quiet.advance(2000); voice.advance(2000);
  assert.equal(voice.ribbon._energy, 0);
  assert.equal(quiet.ribbon.canvas.signature, voice.ribbon.canvas.signature);
  voice.ribbon.level = 1;
  quiet.step(); voice.step();
  assert.ok(voice.ribbon._energy > 0 && voice.ribbon._energy < 0.25);
  quiet.advance(400); voice.advance(400);
  assert.ok(voice.ribbon._energy > 0.99);
  assert.ok(voice.ribbon.canvas.peakAlpha > quiet.ribbon.canvas.peakAlpha);
  assert.notEqual(voice.ribbon.canvas.signature, quiet.ribbon.canvas.signature);
  voice.ribbon.level = 0; voice.step();
  assert.ok(voice.ribbon._energy > 0.8, 'Speech pauses settle gradually rather than flickering');
  voice.advance(2000);
  assert.ok(voice.ribbon._energy < 0.002);
  voice.ribbon.level = 1;
  voice.reduced(true); voice.advance(4000);
  assert.equal(voice.ribbon._energy, 0);
  assert.equal(voice.frames.size + voice.timers.size, 0);
});

test('idle breathing adds gentle light and tilt only to the live composer, respecting static renders', () => {
  const plain = fixture({ size: '96' }), idle = fixture({ size: '96', interaction: 'idle' });
  plain.advance(1200); idle.advance(1200);
  assert.notEqual(idle.ribbon.canvas.signature, plain.ribbon.canvas.signature);
  assert.ok(idle.ribbon.canvas.peakAlpha > plain.ribbon.canvas.peakAlpha);
  const still = fixture({ size: '56', interaction: 'idle', still: '' });
  const original = fixture({ size: '56', still: '' });
  still.step(); original.step();
  assert.equal(still.ribbon.canvas.signature, original.ribbon.canvas.signature);
  assert.equal(still.frames.size + still.timers.size, 0);
});
