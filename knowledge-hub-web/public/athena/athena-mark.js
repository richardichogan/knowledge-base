/* <athena-mark> — Athena's animated mark. Framework-agnostic custom element.
   Attributes: state="resting|listening|thinking|answering"  mode="text|voice"
               variant="ticks|smooth"  size="28" (px, resting diameter)
               level="0..1" (live mic level, voice mode)  palette="#hex,#hex,#hex,#hex"  silent
   Events:     athena-statechange {detail:{from,to}} */
(() => {
  const DEFAULT_PALETTE = ['#4589ff', '#78a9ff', '#0f62fe', '#a6c8ff'];
  const RANK = [0, 1, 3, 2];                 // clockwise rank of piece i (0 TL, 1 TR, 2 BL, 3 BR)
  const TRANSITION_MS = 240;                 // Carbon moderate-02
  const LABELS = { resting: 'Athena', listening: 'Athena is listening', thinking: 'Athena is thinking', answering: 'Athena replied' };

  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = t => ((ax * t + bx) * t + cx) * t, dX = t => (3 * ax * t + 2 * bx) * t + cx;
    return x => {
      let t = x;
      for (let i = 0; i < 6; i++) { const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d; }
      t = Math.min(1, Math.max(0, t));
      return ((ay * t + by) * t + cy) * t;
    };
  }
  const EXPRESSIVE = bezier(0.4, 0.14, 0.3, 1);
  const inOut = u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const outBack = u => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);
  const lerp = (a, b, k) => a + (b - a) * k;
  function kf(u, keys) {
    if (u <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, v0] = keys[i], [t1, v1, ez] = keys[i + 1];
      if (u <= t1) return lerp(v0, v1, (ez || inOut)((u - t0) / (t1 - t0)));
    }
    return keys[keys.length - 1][1];
  }
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

  // Pose: 4 pieces, each {x, y (centre offset px), w, ro (outer radius), ri (inner radius), rot (deg), sc, c:[r,g,b]}
  function grid(s, w, gap, rot, lift, extra) {
    const rad = rot * Math.PI / 180;
    return [0, 1, 2, 3].map(i => {
      const ox = ((i % 2) - 0.5) * (w + gap), oy = ((i >> 1) - 0.5) * (w + gap);
      return Object.assign({ x: ox * Math.cos(rad) - oy * Math.sin(rad), y: ox * Math.sin(rad) + oy * Math.cos(rad) + lift, w, ro: w, ri: 0, rot, sc: 1 }, extra(i));
    });
  }
  function pose(o, t) {
    const s = o.size, P = o.palette.map(rgb), R = o.reduced;
    switch (o.state) {
      case 'listening': {
        const d = 0.22 * s, g = 0.04 * s;
        const lvl = o.level != null ? o.level : 0.5 + 0.5 * Math.sin(t * 5.3);
        return [0, 1, 2, 3].map(i => {
          const y = R ? 0 : o.mode === 'voice'
            ? -(0.55 + 0.45 * Math.sin(t * 11 + i * 2.1)) * Math.abs(Math.sin(t * 7 + i * 0.9)) * 0.5 * s * lvl
            : -Math.abs(Math.sin(t * 17 + i * 1.3)) * 0.2 * s;
          return { x: (i - 1.5) * (d + g), y, w: d, ro: d / 2, ri: d / 2, rot: 0, sc: 1, c: P[0] };
        });
      }
      case 'thinking': {
        const w = 0.36 * s, Q = 0.8;
        const col = i => ({ c: P[RANK[i]] });
        if (R) return grid(s, w, 0.12 * s, 45, 0, col);
        if (o.variant === 'smooth') {
          const gap = (0.06 + 0.14 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / Q))) * s;
          return grid(s, w, gap, (360 * t / (4 * Q)) % 360, 0, i => ({ c: P[RANK[i]], sc: 1 - 0.18 * (0.5 + 0.5 * Math.sin(2 * Math.PI * t / Q - RANK[i] * Math.PI / 2)) }));
        }
        const k = Math.floor(t / Q) % 4, u = (t % Q) / Q;
        const gap = kf(u, [[0, 0.06], [0.3, 0.2], [0.75, 0.2], [1, 0.06]]) * s;
        const rot = (k * 90 + kf(u, [[0.15, 0], [0.75, 90]])) % 360;
        return grid(s, w, gap, rot, 0, i => ({ c: P[RANK[i]], sc: RANK[i] === k ? kf(u, [[0.1, 1], [0.4, 0.78], [0.85, 1, outBack]]) : 1 }));
      }
      case 'answering':
        return grid(s, 0.25 * s, 0.06 * s, 0, 0, () => ({ c: P[0] }));
      default: {
        const breath = R ? 1 : 1 + 0.04 * Math.sin(2 * Math.PI * t / 3.4);
        const gp = ((t - 1.2) % 4 + 4) % 4, on = !R && t > 1.2 && gp < 1;
        return grid(s, 0.5 * s * breath, on ? 0.12 * s * Math.sin(Math.PI * gp) : 0, on ? 90 * inOut(gp) : 0, on ? -0.1 * s * Math.sin(Math.PI * gp) : 0, () => ({ c: P[0] }));
      }
    }
  }
  function blend(a, b, k) {
    return a.map((p, i) => {
      const q = b[i]; let dr = ((q.rot - p.rot) % 360 + 540) % 360 - 180;
      return { x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k), w: lerp(p.w, q.w, k), ro: lerp(p.ro, q.ro, k), ri: lerp(p.ri, q.ri, k), rot: p.rot + dr * k, sc: lerp(p.sc, q.sc, k), c: p.c.map((v, j) => lerp(v, q.c[j], k)) };
    });
  }

  class AthenaMark extends HTMLElement {
    static get observedAttributes() { return ['state', 'mode', 'variant', 'size', 'level', 'palette']; }
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{display:inline-block;vertical-align:middle;line-height:0}.box{position:relative;width:28px;height:28px;overflow:visible}.box>div{position:absolute;will-change:transform}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style><div class="box"><div></div><div></div><div></div><div></div></div><span class="sr" role="status" aria-live="polite"></span>';
      this._box = root.querySelector('.box');
      this._els = [...this._box.children];
      this._live = root.querySelector('.sr');
      this._state = 'resting'; this._start = performance.now(); this._from = null; this._last = null;
      this._visible = true; this._raf = 0;
      this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._tick = this._tick.bind(this);
      this._wake = () => this._schedule();
    }
    get options() {
      const size = parseFloat(this.getAttribute('size')) || 28;
      const pal = (this.getAttribute('palette') || '').split(',').map(x => x.trim()).filter(Boolean);
      const lv = this.getAttribute('level');
      return { state: this._state, mode: this.getAttribute('mode') || 'text', variant: this.getAttribute('variant') || 'ticks', size,
        level: lv == null || lv === '' ? (this._level ?? null) : Math.max(0, Math.min(1, parseFloat(lv))), palette: pal.length === 4 ? pal : DEFAULT_PALETTE, reduced: this._mq.matches };
    }
    set level(v) { this._level = v; }               // set per frame from an AnalyserNode without touching attributes
    get state() { return this._state; }
    set state(v) { this.setAttribute('state', v); }
    connectedCallback() {
      this.setAttribute('role', 'img');
      this._setState(this.getAttribute('state') || 'resting', true);
      this._io = new IntersectionObserver(es => { this._visible = es[0].isIntersecting; this._schedule(); });
      this._io.observe(this);
      document.addEventListener('visibilitychange', this._wake);
      this._mq.addEventListener('change', this._wake);
      this._schedule();
    }
    disconnectedCallback() {
      cancelAnimationFrame(this._raf); this._raf = 0;
      this._io && this._io.disconnect();
      document.removeEventListener('visibilitychange', this._wake);
      this._mq.removeEventListener('change', this._wake);
    }
    attributeChangedCallback(name, _, v) {
      if (name === 'state') this._setState(v || 'resting');
      else this._schedule();
    }
    _setState(next, initial) {
      if (!LABELS[next]) next = 'resting';
      if (next === this._state && !initial) return;
      const prev = this._state;
      this._from = this._last; this._state = next; this._start = performance.now();
      this.setAttribute('aria-label', LABELS[next]);
      if (!initial && !this.hasAttribute('silent') && (next === 'thinking' || next === 'answering')) this._live.textContent = LABELS[next];
      if (!initial) this.dispatchEvent(new CustomEvent('athena-statechange', { detail: { from: prev, to: next }, bubbles: true }));
      this._schedule();
    }
    _schedule() {
      if (this._raf || !this.isConnected) return;
      this._raf = requestAnimationFrame(this._tick);
    }
    _tick(now) {
      this._raf = 0;
      const o = this.options, t = (now - this._start) / 1000;
      const dur = o.reduced ? 0 : TRANSITION_MS;
      let p = pose(o, t);
      const k = dur ? Math.min(1, (now - this._start) / dur) : 1;
      if (this._from && k < 1) p = blend(this._from, p, EXPRESSIVE(k));
      this._render(p, o.size);
      this._last = p;
      const animating = k < 1 || (!o.reduced && o.state !== 'answering');
      if (animating && this._visible && !document.hidden) this._schedule();
    }
    _render(p, s) {
      if (this._size !== s) { this._size = s; this._box.style.width = this._box.style.height = s + 'px'; }
      p.forEach((q, i) => {
        const r = [q.ri, q.ri, q.ri, q.ri]; r[[0, 1, 3, 2][i]] = q.ro;
        const st = this._els[i].style;
        st.width = st.height = q.w + 0.5 + 'px';
        st.left = s / 2 + q.x - q.w / 2 + 'px';
        st.top = s / 2 + q.y - q.w / 2 + 'px';
        st.borderRadius = r.map(v => v + 'px').join(' ');
        st.background = `rgb(${q.c.map(Math.round).join(',')})`;
        st.transform = `rotate(${q.rot}deg) scale(${q.sc})`;
      });
    }
  }
  if (!customElements.get('athena-mark')) customElements.define('athena-mark', AthenaMark);
})();
