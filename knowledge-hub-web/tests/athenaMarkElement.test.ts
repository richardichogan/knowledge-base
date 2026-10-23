import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

type Piece = { style: Record<string, string> };
type Mark = FakeElement & {
  connectedCallback(): void;
  disconnectedCallback(): void;
  attributeChangedCallback(name: string, previous: string | null, next: string): void;
  level: number;
};
const observed = new Set(['state', 'mode', 'variant', 'size', 'level', 'palette']);
class FakeElement {
  attrs = new Map<string, string>();
  isConnected = false;
  pieces: Piece[] = Array.from({ length: 4 }, () => ({ style: {} }));
  box = { children: this.pieces, style: {} };
  live = { textContent: '' };
  attachShadow(): object {
    return { innerHTML: '', querySelector: (selector: string) => selector === '.box' ? this.box : this.live };
  }
  setAttribute(name: string, value: string): void {
    const previous = this.getAttribute(name);
    this.attrs.set(name, value);
    if (observed.has(name) && 'attributeChangedCallback' in this && typeof this.attributeChangedCallback === 'function') {
      this.attributeChangedCallback(name, previous, value);
    }
  }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  dispatchEvent(): boolean { return true; }
}

function fixture() {
  let now = 0, sequence = 0;
  const frames = new Map<number, (time: number) => void>();
  const documentEvents = new Map<string, () => void>();
  const mediaEvents = new Map<string, () => void>();
  const document = {
    hidden: false,
    addEventListener: (name: string, callback: () => void) => { documentEvents.set(name, callback); },
    removeEventListener: (name: string) => { documentEvents.delete(name); },
  };
  const media = {
    matches: false,
    addEventListener: (name: string, callback: () => void) => { mediaEvents.set(name, callback); },
    removeEventListener: (name: string) => { mediaEvents.delete(name); },
  };
  let registered: (new () => Mark) | undefined;
  let visibility: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
  runInNewContext(readFileSync(new URL('../public/athena/athena-mark.js', import.meta.url), 'utf8'), {
    HTMLElement: FakeElement, performance: { now: () => now },
    window: { matchMedia: () => media }, document,
    requestAnimationFrame: (callback: (time: number) => void) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    customElements: { get: () => undefined, define: (_name: string, constructor: new () => Mark) => { registered = constructor; } },
    CustomEvent: class {},
    IntersectionObserver: class {
      constructor(callback: typeof visibility) { visibility = callback; }
      observe(): void {}
      disconnect(): void {}
    },
  });
  assert.ok(registered);
  const mark = new registered();
  mark.isConnected = true;
  mark.connectedCallback();
  return {
    mark, media, document, frames,
    step(time: number) {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
    reduced(value: boolean) { media.matches = value; mediaEvents.get('change')?.(); },
    hidden(value: boolean) { document.hidden = value; documentEvents.get('visibilitychange')?.(); },
    visible(value: boolean) { visibility?.([{ isIntersecting: value }]); },
  };
}

test('supplied element registers, paints four quarters, breathes and parts at rest', () => {
  const f = fixture();
  f.step(0);
  assert.equal(f.mark.getAttribute('role'), 'img');
  assert.equal(f.mark.getAttribute('aria-label'), 'Athena');
  assert.equal(f.mark.pieces.length, 4);
  const initial = f.mark.pieces[0]!.style.width;
  f.step(800);
  assert.notEqual(f.mark.pieces[0]!.style.width, initial);
  f.step(1600);
  assert.notEqual(f.mark.pieces[0]!.style.transform, 'rotate(0deg) scale(1)');
});

test('thinking keeps rounded quarters and four explicit RGB colours rather than CSS colour mixing', () => {
  const f = fixture();
  f.mark.setAttribute('state', 'thinking');
  f.step(700);
  assert.equal(new Set(f.mark.pieces.map(piece => piece.style.background)).size, 4);
  assert.ok(f.mark.pieces.every(piece => /^rgb\(/.test(piece.style.background!)));
  assert.ok(f.mark.pieces.every(piece => piece.style.borderRadius !== '0px 0px 0px 0px'));
  const first = f.mark.pieces[0]!.style.transform;
  f.step(1400);
  assert.notEqual(f.mark.pieces[0]!.style.transform, first);
  f.step(3_200_700);
  assert.ok(f.mark.pieces.every(piece => !JSON.stringify(piece.style).includes('NaN')));
});

test('state changes blend from the current frame, including interruption and repeated thinking state', () => {
  const f = fixture();
  f.step(0);
  f.mark.setAttribute('state', 'thinking');
  f.step(500);
  const frame = f.mark.pieces.map(piece => ({ ...piece.style }));
  f.mark.setAttribute('state', 'answering');
  f.step(500);
  assert.deepEqual(f.mark.pieces.map(piece => piece.style), frame);
  f.mark.setAttribute('state', 'thinking');
  f.step(700);
  const before = f.mark.pieces.map(piece => ({ ...piece.style }));
  f.mark.setAttribute('state', 'thinking');
  f.step(700);
  assert.deepEqual(f.mark.pieces.map(piece => piece.style), before);
});

test('voice mode follows live level, with no simulated waveform when the mic is silent', () => {
  const f = fixture();
  f.mark.setAttribute('state', 'listening');
  f.mark.setAttribute('mode', 'voice');
  f.mark.level = 0;
  f.step(600);
  const silence = f.mark.pieces.map(piece => piece.style.top);
  assert.equal(new Set(silence).size, 1);
  f.mark.level = 1;
  f.step(800);
  assert.notDeepEqual(f.mark.pieces.map(piece => piece.style.top), silence);
});

test('reduced motion is static, answers stop scheduling, and hidden/offscreen marks pause', () => {
  const f = fixture();
  f.reduced(true);
  f.mark.setAttribute('state', 'thinking');
  f.step(500);
  assert.equal(f.frames.size, 0);
  const staticPose = JSON.stringify(f.mark.pieces);
  f.step(1000);
  assert.equal(JSON.stringify(f.mark.pieces), staticPose);
  f.reduced(false);
  f.step(1300);
  assert.ok(f.frames.size > 0);
  f.hidden(true);
  f.step(1500);
  assert.equal(f.frames.size, 0);
  f.hidden(false);
  f.step(1700);
  assert.ok(f.frames.size > 0);
  f.visible(false);
  f.step(1900);
  assert.equal(f.frames.size, 0);
  f.visible(true);
  f.mark.setAttribute('state', 'answering');
  f.step(2400);
  assert.equal(f.frames.size, 0);
  f.mark.disconnectedCallback();
  assert.equal(f.frames.size, 0);
});

test('silent mode avoids duplicate announcements while accessible labels track state', () => {
  const f = fixture();
  f.mark.setAttribute('silent', '');
  f.mark.setAttribute('state', 'thinking');
  assert.equal(f.mark.live.textContent, '');
  assert.equal(f.mark.getAttribute('aria-label'), 'Athena is thinking');
  f.mark.setAttribute('state', 'answering');
  assert.equal(f.mark.getAttribute('aria-label'), 'Athena replied');
});
