/* <athena-ribbon> — Athena as a glowing twisted ribbon inside a glass sphere. Shape and motion carry the emotion.
   Framework-agnostic custom element. No dependencies. Canvas 2D.

   Attributes
     mood     resting | listening | thinking | answering | happy | curious | unsure | sorry | excited   (default resting)
     state    alias for mood (chat-state wiring)
     size     px, square (default 240)
     track    present → ribbon leans toward the pointer
     label    accessible name override (default "Athena")
     silent   present → do not announce mood changes to screen readers
     still    present → render one settled frame and stop (static exports, thumbnails)
     interaction  idle | typing | voice → composer-only attentiveness, without moving the host

   Properties   el.mood (get/set)
   Events       athena-moodchange  { detail: { from, to } }   (bubbles, composed)
*/
(() => {
  // ---- Mood table: each mood overrides BASE. All values are eased toward on change (τ = 380 ms). ----
  const MOODS = {
    resting:   {},
    listening: { pitch: 0.12, amp: 0.12, ripple: 0.07, W: 0.09, bright: 1.25, yawSp: 0.06, sphere: 0.9, lob: 0.04 },
    thinking:  { twist: 3, yawSp: 1.7, spin: 2.6, R: 0.25, amp: 0.55, lobes: 2, lob: 0.14, bright: 1.15, W: 0.1, sphere: 0.7 },
    answering: { R: 0.32, W: 0.14, bright: 1.35, yawSp: 0.35, talk: 1, pitch: 0.35, sphere: 0.8 },
    happy:     { bend: 0.95, pitch: 0.08, roll: 0, W: 0.13, bright: 1.35, bounce: 1, yawSp: 0, amp: 0.12, yaw0: 0, R: 0.31, sphere: 0.8 },
    curious:   { roll: 0.55, pitch: 0.25, yaw0: 0.6, yawSp: 0.05, lob: 0.12, bright: 1.1, scale: 1.04, lean: 1 },
    unsure:    { shake: 1, amp: 0.5, lob: 0.18, lobes: 5, bright: 0.8, twist: 2, yawSp: 0, W: 0.1 },
    sorry:     { bend: -0.9, pitch: 0.1, scale: 0.84, sink: 1, bright: 0.5, yawSp: 0.05, amp: 0.12, sphere: 0.3, roll: 0, yaw0: 0 },
    excited:   { scale: 1.12, yawSp: 1.1, ripple: 0.05, rf: 9, bright: 1.7, bounce: 1.6, twist: 2, sphere: 1 }
  };
  const BASE = { R: 0.3, squash: 0.86, amp: 0.34, lob: 0.07, lobes: 3, twist: 1, W: 0.12, spin: 0.25, yawSp: 0.22, yaw0: 0, pitch: 0.55, roll: 0.3, ripple: 0, rf: 6, bright: 0.85, bend: 0, bounce: 0, sink: 0, shake: 0, talk: 0, sphere: 0.55, scale: 1, lean: 0 };
  const LABELS = { resting: 'Athena', listening: 'Athena is listening', thinking: 'Athena is thinking', answering: 'Athena is answering', happy: 'Athena is happy', curious: 'Athena is curious', unsure: 'Athena is unsure', sorry: 'Athena is sorry', excited: 'Athena is excited' };
  const ANNOUNCE = new Set(['thinking', 'answering', 'sorry']);
  const EASE_TAU = 0.38;      // s, exponential approach for all mood params
  const COLORS = { body: [51, 177, 255], edge: [186, 230, 255] };   // Carbon cyan 40 / cyan 20

  const pointer = { x: null, y: null, t: 0 };
  addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.t = performance.now(); }, { passive: true });

  class AthenaRibbon extends HTMLElement {
    static get observedAttributes() { return ['mood', 'state', 'size', 'label', 'still', 'paused', 'interaction']; }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._mood = 'resting'; this._p = { ...BASE }; this._yaw = 0.6; this._spin = 0; this._t0 = performance.now(); this._raf = 0;
      this._visible = true; this._nx = 0; this._ny = 0;
      this._level = null; this._energy = 0; this._reducedTime = null;
      this._mq = matchMedia('(prefers-reduced-motion: reduce)');
      this._wake = () => this._schedule();
    }
    get mood() { return this._mood; }
    set mood(v) { this.setAttribute('mood', v); }
    get level() { return this._level; }
    set level(v) { this._level = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null; }
    connectedCallback() {
      this.setAttribute('role', 'img');
      this._setMood(this.getAttribute('mood') || this.getAttribute('state') || 'resting', true);
      this._build();
      this._io = new IntersectionObserver(es => { this._visible = es[0].isIntersecting; this._schedule(); });
      this._io.observe(this);
      document.addEventListener('visibilitychange', this._wake);
      this._mq.addEventListener('change', this._wake);
      this._schedule();
    }
    disconnectedCallback() {
      this._pause();
      this._io && this._io.disconnect();
      document.removeEventListener('visibilitychange', this._wake);
      this._mq.removeEventListener('change', this._wake);
    }
    attributeChangedCallback(n, o, v) {
      if (n === 'mood' || n === 'state') this._setMood(v || 'resting');
      else if (n === 'size' && this.isConnected && o !== v) this._build();
      else if (n === 'label') this.setAttribute('aria-label', v || LABELS[this._mood]);
      if (n === 'still' && this.isConnected) this._settle();
      this._schedule();
    }
    _setMood(next, initial) {
      if (!Object.hasOwn(MOODS, next)) next = 'resting';
      if (next === this._mood && !initial) return;
      const prev = this._mood;
      this._mood = next; this._t0 = performance.now();
      this.setAttribute('aria-label', this.getAttribute('label') || LABELS[next]);
      if (this.hasAttribute('still')) this._settle();
      if (initial) return;
      if (this._live && !this.hasAttribute('silent') && ANNOUNCE.has(next)) this._live.textContent = LABELS[next];
      this.dispatchEvent(new CustomEvent('athena-moodchange', { detail: { from: prev, to: next }, bubbles: true, composed: true }));
    }
    _target() {
      const target = { ...BASE, ...MOODS[this._mood] };
      if (this.getAttribute('interaction') === 'typing' && this._mood === 'listening') {
        Object.assign(target, { roll: -0.35, pitch: 0.16, yawSp: 0.12, ripple: 0.09, rf: 8, bright: 1.5, W: 0.14, scale: 1.1, lean: 0.8 });
      }
      return target;
    }
    _settle() { this._p = this._target(); }
    _pause() { cancelAnimationFrame(this._raf); clearTimeout(this._to); this._raf = 0; this._last = null; }
    _schedule() {
      if (!this.isConnected || !this._visible || document.hidden || this.hasAttribute('paused')) { this._pause(); return; }
      if (this._raf || !this._ctx) return;
      const go = () => { cancelAnimationFrame(this._raf); clearTimeout(this._to); this._raf = 0; this._tick(performance.now()); };
      this._raf = requestAnimationFrame(go); this._to = setTimeout(go, 40);   // timeout keeps throttled iframes ticking
    }
    _build() {
      const s = parseFloat(this.getAttribute('size')) || 240, dpr = Math.min(2, devicePixelRatio || 1);
      this._s = s;
      this.shadowRoot.innerHTML = `<style>
        :host{display:inline-block;line-height:0;vertical-align:middle}
        .w{position:relative;width:${s}px;height:${s}px}
        .sph{position:absolute;inset:${s * 0.06}px;border-radius:50%;
          background:radial-gradient(circle at 50% 50%, rgba(0,20,40,0) 55%, rgba(130,207,255,.07) 88%, rgba(186,230,255,.14) 100%);
          box-shadow:inset 0 0 ${s * 0.08}px rgba(51,177,255,.10), 0 0 ${s * 0.12}px rgba(17,146,232,.10)}
        canvas{position:absolute;inset:0;width:${s}px;height:${s}px}
        .glow{filter:blur(${Math.max(2, s * 0.035)}px);mix-blend-mode:screen;opacity:.95}
        .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
      </style><div class="w" aria-hidden="true"><div class="sph"></div><canvas class="glow"></canvas><canvas class="main"></canvas></div><span class="sr" role="status" aria-live="polite"></span>`;
      const r = this.shadowRoot;
      this._cv = r.querySelector('.main'); this._gl = r.querySelector('.glow'); this._sph = r.querySelector('.sph'); this._live = r.querySelector('.sr');
      [this._cv, this._gl].forEach(c => { c.width = c.height = Math.round(s * dpr); });
      this._ctx = this._cv.getContext('2d'); this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._gctx = this._gl.getContext('2d');
      this._S = s < 60 ? 10 : s < 140 ? 22 : 36;     // strands across the ribbon
      this._N = s < 60 ? 90 : 150;                    // samples around the loop
      this._last = null;
    }
    _tick(now) {
      const still = this.hasAttribute('still');
      const dt = Math.min(0.064, (now - (this._last ?? now)) / 1000); this._last = now;
      const R = this._mq.matches || still, tgt = this._target(), p = this._p;
      const k = still ? 1 : 1 - Math.exp(-dt / EASE_TAU);
      for (const key in BASE) p[key] += (tgt[key] - p[key]) * k;
      const level = !R && this.getAttribute('interaction') === 'voice' && this._mood === 'listening' ? this._level ?? 0 : 0;
      this._energy = R ? 0 : this._energy + (level - this._energy) * (1 - Math.exp(-dt / (level > this._energy ? 0.08 : 0.3)));
      if (!R) { this._yaw += p.yawSp * dt; this._spin += p.spin * dt; }
      if (!R) this._reducedTime = null;
      else this._reducedTime ??= now / 1000;
      this._draw(R ? this._reducedTime : now / 1000, (now - this._t0) / 1000, R);
      const settling = Object.keys(BASE).some(key => Math.abs(tgt[key] - p[key]) > 0.0001);
      if (!still && (!R || settling)) this._schedule();
    }
    _draw(t, tt, R) {
      const s = this._s, ctx = this._ctx, p = this._p, S = this._S, N = this._N, c = s / 2;
      const waiting = !R && this.getAttribute('interaction') === 'idle' && this._mood === 'resting';
      const breath = waiting ? Math.sin(2 * Math.PI * t / 5.6) : 0;
      const energy = R ? 0 : this._energy;
      const listeningLevel = this.getAttribute('interaction') === 'voice' ? energy : this._level ?? 1;
      ctx.clearRect(0, 0, s, s);
      let nx = 0, ny = 0;
      if (!R && this.hasAttribute('track') && pointer.x != null && performance.now() - pointer.t < 4000) {
        const b = this.getBoundingClientRect(), span = Math.max(300, s * 1.6);
        nx = Math.max(-1, Math.min(1, (pointer.x - b.left - b.width / 2) / span)); ny = Math.max(-1, Math.min(1, (pointer.y - b.top - b.height / 2) / span));
      }
      this._nx += (nx - this._nx) * 0.06; this._ny += (ny - this._ny) * 0.06;
      if (R) this._nx = this._ny = 0;
      const breathe = R ? 1 : 1 + 0.03 * Math.sin(2 * Math.PI * t / 4.2);
      const bounce = R ? 0 : p.bounce * Math.abs(Math.sin(t * 4.2)) * 0.05;
      const shake = R ? 0 : p.shake * Math.sin(t * 5.2) * Math.max(0, Math.sin(t * 1.1)) * 0.5;
      const talk = R ? 0 : p.talk * (tt < 3 ? Math.abs(Math.sin(tt * 9)) * (0.6 + 0.4 * Math.sin(tt * 3.3)) : 0.15 * Math.abs(Math.sin(tt * 2)));
      const scale = s * p.scale * breathe * (1 + 0.06 * talk);
      const yaw = this._yaw + p.yaw0 + shake + this._nx * 0.5, pitch = p.pitch + this._ny * 0.4 - energy * 0.06,
        roll = p.roll + p.lean * this._nx * 0.2 + (waiting ? 0.06 * Math.sin(t * 0.35) : 0);
      const cy0 = c + s * (-bounce + p.sink * 0.06), cx0 = c + p.lean * s * 0.03;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
      const D = 2.6;                                  // camera distance (perspective)
      const pts = new Float32Array((N + 1) * 3);
      ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      const bright = p.bright * (1 + 0.1 * breath + 0.32 * energy) * (s < 60 ? 2.5 : 1), CH = 10;
      for (let j = 0; j < S; j++) {
        const v = S === 1 ? 0 : (j / (S - 1)) * 2 - 1, edge = Math.abs(v) > 0.93;
        for (let i = 0; i <= N; i++) {
          const th = (i / N) * Math.PI * 2;
          const rr = p.R * (1 + p.lob * Math.sin(p.lobes * th + t * 0.4) + (p.ripple * (this._mood === 'listening' ? listeningLevel : 1) + 0.03 * talk) * Math.sin(p.rf * th - t * 7));
          let x = rr * Math.cos(th), y = rr * Math.sin(th) * p.squash, z = p.R * p.amp * Math.sin(2 * th + 0.6);
          const tau = p.twist * th / 2 + this._spin;
          const rx = Math.cos(th), ry = Math.sin(th) * p.squash, rl = Math.hypot(rx, ry) || 1;
          const w = p.W * (1 + 0.35 * talk + 0.18 * energy);
          x += v * w * Math.cos(tau) * rx / rl; y += v * w * Math.cos(tau) * ry / rl; z += v * w * Math.sin(tau);
          y -= p.bend * (x * x / (p.R * p.R) - 0.45) * p.R * 0.6;
          const X = x * cyw + z * syw, Z = -x * syw + z * cyw;
          const Y2 = y * cp - Z * sp, Z2 = y * sp + Z * cp;
          const X3 = X * cr - Y2 * sr, Y3 = X * sr + Y2 * cr;
          const f = D / (D - Z2);
          pts[i * 3] = cx0 + X3 * f * scale; pts[i * 3 + 1] = cy0 + Y3 * f * scale; pts[i * 3 + 2] = Z2;
        }
        const baseA = (edge ? 0.38 : 0.1) * bright, lw = edge ? Math.max(1, s * 0.0045) : Math.max(0.75, s * 0.003);
        const col = edge ? COLORS.edge : COLORS.body;
        ctx.lineWidth = lw;
        for (let i0 = 0; i0 < N; i0 += CH) {
          const i1 = Math.min(N, i0 + CH), zm = (pts[i0 * 3 + 2] + pts[i1 * 3 + 2]) / 2;
          const depth = 0.4 + 0.6 * Math.max(0, Math.min(1, (zm / (p.R * 1.2)) * 0.5 + 0.5));
          const lx = (pts[i0 * 3] + pts[i1 * 3]) / 2 - c, ly = (pts[i0 * 3 + 1] + pts[i1 * 3 + 1]) / 2 - c;
          const light = Math.max(0.45, Math.min(1.6, 0.95 + (lx * 0.8 - ly * 0.5) / (s * 0.3)));
          ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${Math.min(1, baseA * depth * light)})`;
          ctx.beginPath(); ctx.moveTo(pts[i0 * 3], pts[i0 * 3 + 1]);
          for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(pts[i * 3], pts[i * 3 + 1]);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      const g = this._gctx; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this._gl.width, this._gl.height); g.drawImage(this._cv, 0, 0);
      this._sph.style.opacity = Math.min(1, 0.35 + 0.65 * p.sphere);
      this._sph.style.transform = `translateY(${(-bounce + p.sink * 0.03) * s * 0.5}px) scale(${0.98 + 0.03 * p.scale})`;
    }
  }
  AthenaRibbon.MOODS = Object.keys(MOODS);
  if (!customElements.get('athena-ribbon')) customElements.define('athena-ribbon', AthenaRibbon);
})();
