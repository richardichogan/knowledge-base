(() => {
  const BG = '#161616';
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const KIND = {
    member: { L: 70, k: 0.1, a: 0.32, c: '#8d8d8d' },
    internal: { L: 55, k: 0.05, a: 0.2, c: '#8d8d8d' },
    cross: { L: 190, k: 0.02, a: 0.75, c: '#c6c6c6', dash: [5, 5] },
    island: { L: 38, k: 0.15, a: 0.35, c: '#8d8d8d' }
  };
  const random = () => {
    let seed = 11;
    return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function hull(pts) {
    if (pts.length < 3) return pts.slice();
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }
  const bez = (t, a, c, b) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;

  class AtlasGraph extends HTMLElement {
    static get observedAttributes() { return ['selected', 'path', 'hide-types', 'context', 'search', 'range', 'group', 'scope', 'depth', 'compact']; }
    set data(d) {
      const unchanged = this._data === d || (this._data && JSON.stringify(this._data) === JSON.stringify(d));
      this._data = d;
      // Query refreshes and repeated React effects must not replay the graph's entry animation.
      if (unchanged && this.nodes) return;
      if (this.isConnected) { this.init(); this.fitted = false; this.resize(); this.schedule(); }
    }
    get data() { return this._data || window.ATLAS; }
    constructor() {
      super();
      const r = this.attachShadow({ mode: 'open' });
      r.innerHTML = '<style>:host{display:block;position:relative;width:100%;height:100%;touch-action:none;user-select:none}canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab}</style><canvas></canvas>';
      this.cv = r.querySelector('canvas');
      this.ctx = this.cv.getContext('2d');
      this.hc = document.createElement('canvas');
      this.hctx = this.hc.getContext('2d');
      this.cam = { x: 0, y: 0, k: 1 }; this.camT = null;
      this.sel = null; this.path = []; this.hideTypes = new Set(); this.search = ''; this.range = 9999; this.group = '';
      this.hover = null; this.pathStart = 0; this.w = 0; this.h = 0;
      this.loop = this.loop.bind(this);
      this.onCmd = e => this.cmd(e.detail);
      this.scope = ''; this.depth = 2; this.compact = false;
      this.context = new Set();
      this.onscreen = true;
      this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.onVisibility = () => {
        if (!document.hidden && this.onscreen) this.schedule();
        else { cancelAnimationFrame(this.raf); clearTimeout(this.to); }
      };
      this.onMotion = () => {
        this.reduced = this.media.matches;
        if (this.reduced && this.nodes) { for (let i = 0; i < 320; i++) this.tick(); this.autoFit = 0; }
        this.schedule();
      };
    }
    init() {
      const D = this.data;
      if (!D) return;
      const rnd = this.rnd = random();
      this.down = null; this.dragging = false; this.hover = null; this.pinch = null;
      this.cv.title = '';
      this.pointers?.clear();
      this.types = D.types;
      this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let srcN = D.nodes, srcE = D.edges;
      if (this.scope) {
        const adj = {};
        srcE.forEach(e => { (adj[e.a] = adj[e.a] || []).push(e.b); (adj[e.b] = adj[e.b] || []).push(e.a); });
        const keep = new Set([this.scope]); let fr = [this.scope];
        for (let d = 0; d < this.depth; d++) { const nx = []; fr.forEach(id => (adj[id] || []).forEach(o => { if (!keep.has(o)) { keep.add(o); nx.push(o); } })); fr = nx; }
        srcN = srcN.filter(n => keep.has(n.id)); srcE = srcE.filter(e => keep.has(e.a) && keep.has(e.b));
      }
      this.nodes = srcN.map(n => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, deg: 0, stiffness: 0, fx: null, fy: null }));
      this.by = Object.fromEntries(this.nodes.map(n => [n.id, n]));
      this.edges = srcE.filter(e => this.by[e.a] && this.by[e.b]).map(e => ({ ...e, A: this.by[e.a], B: this.by[e.b], ph: rnd() }));
      this.edges.forEach(e => {
        e.A.deg++; e.B.deg++;
        const stiffness = (KIND[e.kind] || KIND.member).k;
        e.A.stiffness += stiffness; e.B.stiffness += stiffness;
      });
      const hubs = this.nodes.filter(n => n.hub);
      const hr = this.scope ? 110 : 300;
      hubs.forEach((h, i) => { const a = (i / hubs.length) * Math.PI * 2; h.x = Math.cos(a) * hr; h.y = Math.sin(a) * hr * 0.77; });
      const ia = {};
      this.nodes.forEach(n => {
        n.r = n.hub ? 9 + Math.sqrt(n.deg) * 1.1 : 3 + Math.sqrt(n.deg) * 1.7;
        if (n.hub) return;
        n.seed = rnd() * 100;
        const h = n.project && this.by[n.project];
        if (h) { n.x = h.x + (rnd() - 0.5) * 16; n.y = h.y + (rnd() - 0.5) * 16; }
        else if (this.scope) { n.x = (rnd() - 0.5) * 60; n.y = (rnd() - 0.5) * 60; }
        else { if (ia[n.island] == null) ia[n.island] = rnd() * Math.PI * 2; n.x = Math.cos(ia[n.island]) * 560 + (rnd() - 0.5) * 40; n.y = Math.sin(ia[n.island]) * 430 + (rnd() - 0.5) * 40; }
      });
      this.projects = hubs.map(h => ({ hub: h, mem: this.nodes.filter(n => !n.hub && n.project === h.id) }));
      this.nodes.forEach(n => { if (n.seed == null) n.seed = rnd() * 100; });
      const root = this.scope && this.by[this.scope];
      if (root) { root.x = root.y = 0; root.pin = true; }
      this.alpha = 1; this.alphaTarget = 0.04; this.time = 0; this.t0 = 0;
      for (let i = 0; i < (this.reduced ? 320 : 6); i++) this.tick();
      this.autoFit = this.reduced ? 0 : performance.now() + 3200;
    }
    connectedCallback() {
      if (!this.nodes && this.data) this.init();
      this.bind();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
      window.addEventListener('atlas-cmd', this.onCmd);
      document.addEventListener('visibilitychange', this.onVisibility);
      this.media.addEventListener('change', this.onMotion);
      this.io = new IntersectionObserver(([entry]) => { this.onscreen = entry?.isIntersecting ?? false; this.onVisibility(); });
      this.io.observe(this);
      this.resize();
      this.running = true;
      this.schedule();
    }
    disconnectedCallback() {
      this.running = false; cancelAnimationFrame(this.raf); clearTimeout(this.to);
      this.ro && this.ro.disconnect();
      this.io && this.io.disconnect();
      window.removeEventListener('atlas-cmd', this.onCmd);
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.media.removeEventListener('change', this.onMotion);
      this.down = null; this.dragging = false;
      this.pointers?.clear();
    }
    attributeChangedCallback(name, _, v) {
      if (_ === v) return;
      if (name === 'compact') { this.compact = v !== null && v !== 'false'; return; }
      v = v || '';
      if (name === 'selected') {
        this.autoFit = 0;
        this.sel = v || null;
        const n = this.sel && this.by && this.by[this.sel];
        if (n && this.w) { this.camT = { x: n.x, y: n.y, k: Math.max(this.cam.k, 1.3) }; this.alpha = Math.max(this.alpha, 0.12); }
      } else if (name === 'path') {
        this.autoFit = 0;
        this.path = v ? v.split(',') : [];
        if (this.path.length) { this.pathStart = performance.now(); this.fitTo(this.path, true, 200); }
      } else if (name === 'hide-types') this.hideTypes = new Set(v ? v.split(',') : []);
      else if (name === 'context') this.context = new Set(v ? v.split(',') : []);
      else if (name === 'search') this.search = v.trim().toLowerCase();
      else if (name === 'range') this.range = parseFloat(v) || 9999;
      else if (name === 'scope' || name === 'depth') {
        if (name === 'scope') this.scope = v; else this.depth = parseInt(v) || 2;
        if (this.nodes && this.isConnected) { this.init(); this.fitted = false; this.resize(); }
      } else if (name === 'compact') this.compact = v !== null && v !== 'false';
      else if (name === 'group') {
        this.autoFit = 0;
        this.group = v;
        if (v === 'islands' && this.nodes) this.fitTo(this.nodes.filter(n => !n.project).map(n => n.id), true, 120);
      }
      if (this.reduced && this.camT) { this.cam = this.camT; this.camT = null; }
      this.schedule();
    }
    resize() {
      const wasHidden = !this.w || !this.h;
      const r = this.getBoundingClientRect();
      this.w = r.width; this.h = r.height; this.dpr = window.devicePixelRatio || 1;
      this.surface = this.compact ? getComputedStyle(this).getPropertyValue('--atlas-surface').trim() || '#262626' : BG;
      for (const c of [this.cv, this.hc]) { c.width = Math.max(1, Math.round(this.w * this.dpr)); c.height = Math.max(1, Math.round(this.h * this.dpr)); }
      if (wasHidden && this.w > 0 && this.h > 0) {
        this.fitted = false;
        if (this.autoFit) this.autoFit = performance.now() + 3200;
      }
      if (!this.fitted && this.nodes && this.w > 0 && this.h > 0) { this.fitted = true; this.fitTo(null, false, this.compact ? 70 : 80); }
      if (this.reduced) this.schedule();
    }
    isVis(n) { return n.hub || !this.hideTypes.has(n.type) || this.context.has(n.id); }
    fitTo(ids, anim, margin) {
      if (!this.nodes || !this.w) return;
      const list = (ids ? ids.map(i => this.by[i]).filter(Boolean) : this.nodes.filter(n => this.isVis(n)));
      if (!list.length) return;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      list.forEach(n => { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); });
      const mx = this.compact ? 56 : margin, my = this.compact ? 44 : margin;
      const k = clamp(Math.min((this.w - mx * 2) / Math.max(x1 - x0, 1), (this.h - my * 2) / Math.max(y1 - y0, 1)), this.compact ? 0.15 : 0.3, this.compact ? 1.6 : 2.2);
      const t = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k };
      if (anim && !this.reduced) this.camT = t; else { this.cam = t; this.camT = null; }
    }
    cmd(c) {
      if (!this.nodes) return;
      this.autoFit = 0;
      if (c === 'reflow') { this.init(); this.fitted = false; this.resize(); this.schedule(); return; }
      if (c === 'fit') { this.fitTo(this.path.length ? this.path : this.group === 'islands' ? this.nodes.filter(n => !n.project).map(n => n.id) : null, true, this.compact ? 70 : 80); this.schedule(); return; }
      const k = clamp(this.cam.k * (c === 'in' ? 1.35 : 1 / 1.35), 0.25, 4);
      this.camT = { x: this.cam.x, y: this.cam.y, k };
      if (this.reduced) { this.cam = this.camT; this.camT = null; }
      this.schedule();
    }
    tick() {
      const N = this.nodes, a = this.alpha, sel = this.sel, rnd = this.rnd;
      for (let i = 0; i < N.length; i++) {
        const p = N[i];
        for (let j = i + 1; j < N.length; j++) {
          const q = N[j];
          let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
          if (d2 > 640000) continue;
          if (d2 < 1) { dx = rnd() - 0.5; dy = rnd() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2);
          const same = p.project && p.project === q.project;
          const sc = this.scope;
          const s = p.hub && q.hub ? (sc ? 120 : 1400) : same ? (sc ? 40 : 50) : p.hub || q.hub ? (sc ? 60 : 160) : (sc ? 45 : 110);
          const f = (s * a) / d2;
          p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f;
        }
      }
      for (const e of this.edges) {
        const K = KIND[e.kind] || KIND.member;
        let L = sel && (e.a === sel || e.b === sel) ? K.L * 0.75 : K.L;
        if (this.scope) { L = Math.min(L, 80); if (e.a === this.scope || e.b === this.scope) L = Math.max(L, 70); }
        const dx = e.B.x - e.A.x, dy = e.B.y - e.A.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - L) / d) * K.k * a;
        // Dense real-data hubs need degree-weighted inertia; summed springs otherwise explode.
        const fa = f / Math.max(1, e.A.stiffness), fb = f / Math.max(1, e.B.stiffness);
        e.A.vx += dx * fa; e.A.vy += dy * fa; e.B.vx -= dx * fb; e.B.vy -= dy * fb;
      }
      for (const n of N) {
        if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
        if (n.pin) { n.x *= 0.8; n.y *= 0.8; n.vx = n.vy = 0; continue; }
        const gx = this.scope ? 0.01 : 0.004, gy = this.scope ? 0.012 : 0.0055;
        n.vx -= n.x * gx * a; n.vy -= n.y * gy * a;
        if (!this.dragging && !this.reduced) { const w = n.hub ? 0.012 : 0.035; n.vx += Math.sin(this.time * 0.5 + n.seed) * w; n.vy += Math.cos(this.time * 0.43 + n.seed * 1.7) * w; }
        n.vx *= 0.6; n.vy *= 0.6;
        n.x += n.vx; n.y += n.vy;
      }
      this.alpha += (this.alphaTarget - this.alpha) * 0.0228;
    }
    loop(now) {
      if (!this.running || !this.nodes || document.hidden || !this.onscreen) return;
      if (this.lastT && now - this.lastT < 12) { this.schedule(); return; }
      this.lastT = now;
      if (!this.t0) this.t0 = now;
      this.time = (now - this.t0) / 1000;
      if (!this.w) this.resize();
      if (!this.reduced || this.dragging) this.tick();
      if (this.autoFit && now < this.autoFit && !this.down && this.w) this.fitTo(null, true, this.compact ? 70 : 80);
      else this.autoFit = 0;
      if (this.camT) {
        const c = this.cam, t = this.camT;
        c.x += (t.x - c.x) * 0.14; c.y += (t.y - c.y) * 0.14; c.k += (t.k - c.k) * 0.14;
        if (Math.abs(t.x - c.x) < 0.3 && Math.abs(t.y - c.y) < 0.3 && Math.abs(t.k - c.k) < 0.002) { this.cam = { ...t }; this.camT = null; }
      }
      if (this.w) this.draw(now);
      if (!this.reduced || this.dragging) this.schedule();
    }
    schedule() {
      cancelAnimationFrame(this.raf); clearTimeout(this.to);
      if (!this.running || !this.nodes || document.hidden || !this.onscreen) return;
      const go = () => { cancelAnimationFrame(this.raf); clearTimeout(this.to); this.loop(performance.now()); };
      this.raf = requestAnimationFrame(go);
      this.to = setTimeout(go, 40);
    }
    S(n) { return [(n.x - this.cam.x) * this.cam.k + this.w / 2, (n.y - this.cam.y) * this.cam.k + this.h / 2]; }
    world(p) { return [(p[0] - this.w / 2) / this.cam.k + this.cam.x, (p[1] - this.h / 2) / this.cam.k + this.cam.y]; }
    zr() { return clamp(Math.sqrt(this.cam.k), 0.7, 1.8); }
    pick(p) {
      let best = null, bd = 1e9; const zr = this.zr();
      for (const n of this.nodes) {
        if (!this.isVis(n)) continue;
        const [sx, sy] = this.S(n), d = Math.hypot(sx - p[0], sy - p[1]);
        if (d < n.r * zr + 7 && d < bd) { bd = d; best = n; }
      }
      return best;
    }
    pos(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    emit(id) { this.dispatchEvent(new CustomEvent('atlas-select', { detail: { id }, bubbles: true, composed: true })); }
    bind() {
      if (this.bound) return; this.bound = true;
      const c = this.cv;
      this.pointers = new Map();
      const pinch = () => {
        const [a, b] = [...this.pointers.values()];
        return a && b ? { centre: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], distance: Math.hypot(a[0] - b[0], a[1] - b[1]) } : null;
      };
      c.addEventListener('pointerdown', e => {
        if (!this.nodes || e.button > 0) return;
        const p = this.pos(e);
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 2) {
          if (this.down?.hit) this.down.hit.fx = this.down.hit.fy = null;
          this.down = null; this.dragging = false; this.alphaTarget = 0.04;
          this.pinch = pinch(); this.camT = null; this.autoFit = 0; c.setPointerCapture(e.pointerId);
          return;
        }
        this.down = { p, hit: this.pick(p), moved: false, cam: { ...this.cam } };
        this.camT = null; this.autoFit = 0; c.setPointerCapture(e.pointerId);
        c.style.cursor = this.down.hit ? 'grabbing' : 'grabbing';
      });
      c.addEventListener('pointermove', e => {
        if (!this.nodes) return;
        const p = this.pos(e), d = this.down;
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
        if (this.pinch) {
          const next = pinch();
          if (next) {
            const w = this.world(this.pinch.centre);
            this.cam.k = clamp(this.cam.k * next.distance / Math.max(1, this.pinch.distance), 0.25, 4);
            this.cam.x = w[0] - (next.centre[0] - this.w / 2) / this.cam.k;
            this.cam.y = w[1] - (next.centre[1] - this.h / 2) / this.cam.k;
            this.pinch = next; this.schedule();
          }
          return;
        }
        if (d) {
          if (Math.hypot(p[0] - d.p[0], p[1] - d.p[1]) > 4) d.moved = true;
          if (!d.moved) return;
          if (d.hit) { const w = this.world(p); d.hit.fx = w[0]; d.hit.fy = w[1]; this.dragging = true; this.alphaTarget = 0.3; this.alpha = Math.max(this.alpha, 0.3); }
          else { this.cam.x = d.cam.x - (p[0] - d.p[0]) / this.cam.k; this.cam.y = d.cam.y - (p[1] - d.p[1]) / this.cam.k; }
        } else {
          this.hover = this.pick(p);
          c.title = this.hover?.name || '';
          c.style.cursor = this.hover ? 'pointer' : 'grab';
        }
        this.schedule();
      });
      const up = e => {
        this.pointers.delete(e.pointerId);
        if (this.pinch) { if (!this.pointers.size) this.pinch = null; return; }
        const d = this.down; if (!d) return;
        if (d.hit) { d.hit.fx = d.hit.fy = null; }
        this.dragging = false; this.alphaTarget = 0.04;
        if (!d.moved && e.type !== 'pointercancel') this.emit(d.hit ? d.hit.id : null);
        this.down = null; c.style.cursor = this.hover ? 'pointer' : 'grab';
        if (this.reduced) { for (let i = 0; i < 320; i++) this.tick(); }
        this.schedule();
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('pointerleave', () => { if (!this.down) { this.hover = null; c.title = ''; this.schedule(); } });
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const p = this.pos(e), w = this.world(p);
        const k = clamp(this.cam.k * Math.exp(-e.deltaY * 0.0015), 0.25, 4);
        this.camT = null; this.autoFit = 0; this.cam.k = k;
        this.cam.x = w[0] - (p[0] - this.w / 2) / k; this.cam.y = w[1] - (p[1] - this.h / 2) / k;
        this.schedule();
      }, { passive: false });
    }
    draw(now) {
      const ctx = this.ctx, W = this.w, H = this.h, k = this.cam.k, t = now / 1000, zr = this.zr(), T = this.types;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.shadowBlur = 0;
      if (this.compact) ctx.clearRect(0, 0, W, H);
      else { ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); }
      const gs = 48 * k;
      if (!this.compact && gs > 14) {
        ctx.fillStyle = '#262626';
        const ox = (((W / 2 - this.cam.x * k) % gs) + gs) % gs, oy = (((H / 2 - this.cam.y * k) % gs) + gs) % gs;
        for (let x = ox; x < W; x += gs) for (let y = oy; y < H; y += gs) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
      const q = this.search, sel = this.sel, hov = this.hover && this.hover.id, focus = hov || sel, group = this.group;
      const nb = new Set();
      if (focus) for (const e of this.edges) { if (e.a === focus) nb.add(e.b); if (e.b === focus) nb.add(e.a); }
      const path = this.path.filter(id => this.by[id]), pset = new Set(path);
      const inRange = n => n.last <= this.range;
      const match = n => !q || n.name.toLowerCase().includes(q);
      const lit = n => {
        if (!inRange(n) || !match(n)) return false;
        if (path.length) return pset.has(n.id);
        if (focus) return n.id === focus || nb.has(n.id);
        if (group === 'islands') return !n.project;
        return true;
      };
      const quiet = path.length || focus || group || q;

      // project hulls
      const pad = (this.compact ? 16 : 26) * zr, hx = this.hctx, fN = focus && this.by[focus];
      for (const p of this.projects) {
        const pts = [p.hub, ...p.mem].filter(n => this.isVis(n)).map(n => this.S(n));
        const h = hull(pts);
        hx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        hx.clearRect(0, 0, W, H);
        hx.beginPath(); h.forEach((pt, i) => (i ? hx.lineTo(pt[0], pt[1]) : hx.moveTo(pt[0], pt[1]))); hx.closePath();
        hx.lineJoin = 'round'; hx.lineCap = 'round'; hx.lineWidth = pad * 2; hx.strokeStyle = hx.fillStyle = '#ffffff';
        hx.stroke(); hx.fill();
        const mine = fN && fN.project === p.hub.id;
        ctx.globalAlpha = mine ? 0.075 : quiet ? 0.022 : 0.045;
        ctx.drawImage(this.hc, 0, 0, W, H);
      }
      ctx.textAlign = 'left';

      // edges
      const flows = [];
      const ctrl = (a, b) => [(a[0] + b[0]) / 2 - (b[1] - a[1]) * 0.1, (a[1] + b[1]) / 2 + (b[0] - a[0]) * 0.1];
      for (const e of this.edges) {
        if (!this.isVis(e.A) || !this.isVis(e.B)) continue;
        const K = KIND[e.kind] || KIND.member;
        const touch = focus && (e.a === focus || e.b === focus);
        let al = K.a;
        if (path.length) al = 0.05;
        else if (focus) al = touch ? 0.85 : 0.04;
        else if (group === 'islands') al = e.kind === 'island' ? 0.7 : 0.04;
        if (!lit(e.A) || !lit(e.B)) al = Math.min(al, 0.05);
        const a = this.S(e.A), b = this.S(e.B), c = ctrl(a, b);
        ctx.globalAlpha = al;
        ctx.strokeStyle = touch && !path.length ? T[this.by[focus].type].color : K.c;
        ctx.lineWidth = touch ? 1.6 : e.kind === 'cross' ? 1.2 : 1;
        ctx.setLineDash(e.inferred ? [3, 4] : K.dash || []);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke();
        if (touch && !path.length) flows.push([e.a === focus ? a : b, c, e.a === focus ? b : a, e.ph]);
      }
      ctx.setLineDash([]);
      if (!focus && !path.length && !this.reduced) {
        ctx.fillStyle = '#f4f4f4';
        for (const e of this.edges) {
          if (e.kind !== 'cross' || !this.isVis(e.A) || !this.isVis(e.B) || !lit(e.A) || !lit(e.B)) continue;
          const a = this.S(e.A), b = this.S(e.B), c = ctrl(a, b), u = (t * 0.18 + e.ph) % 1;
          ctx.globalAlpha = Math.sin(u * Math.PI) * 0.9;
          ctx.beginPath(); ctx.arc(bez(u, a[0], c[0], b[0]), bez(u, a[1], c[1], b[1]), 1.8, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      if (flows.length && !this.reduced) {
        ctx.globalAlpha = 1; ctx.fillStyle = T[this.by[focus].type].color;
        for (const [a, c, b, ph] of flows) for (let j = 0; j < 2; j++) {
          const u = (t * 0.45 + ph + j * 0.5) % 1;
          ctx.beginPath(); ctx.arc(bez(u, a[0], c[0], b[0]), bez(u, a[1], c[1], b[1]), 2, 0, Math.PI * 2); ctx.fill();
        }
      }

      // path
      if (path.length > 1) {
        const el = now - this.pathStart - 200;
        ctx.strokeStyle = '#4589ff'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.shadowColor = '#4589ff'; ctx.shadowBlur = 12; ctx.globalAlpha = 1;
        const segs = [];
        for (let i = 0; i < path.length - 1; i++) {
          const a = this.S(this.by[path[i]]), b = this.S(this.by[path[i + 1]]), c = ctrl(a, b);
          segs.push([a, c, b]);
          const pr = this.reduced ? 1 : clamp((el - i * 350) / 350, 0, 1);
          if (pr <= 0) continue;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]);
          for (let s = 1; s <= 24; s++) { const u = (s / 24) * pr; ctx.lineTo(bez(u, a[0], c[0], b[0]), bez(u, a[1], c[1], b[1])); }
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        if (!this.reduced && el > (path.length - 1) * 350) {
          ctx.fillStyle = '#ffffff';
          const n = segs.length, u = (t * 0.35) % 1, si = Math.floor(u * n), lu = u * n - si, [a, c, b] = segs[si];
          ctx.beginPath(); ctx.arc(bez(lu, a[0], c[0], b[0]), bez(lu, a[1], c[1], b[1]), 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }

      // nodes
      const order = this.nodes.filter(n => this.isVis(n)).sort((a, b) => (a.hub - b.hub));
      for (const n of order) {
        const [sx, sy] = this.S(n);
        if (sx < -60 || sy < -60 || sx > W + 60 || sy > H + 60) continue;
        const grow = this.reduced ? 1 : clamp((this.time - (n.hub ? 0 : 0.15 + (n.seed % 1) * 0.6)) / 0.5, 0, 1);
        if (grow <= 0) continue;
        const rs = n.r * zr * (n.hub ? 1 : 0.4 + 0.6 * grow), L = lit(n), col = T[n.type].color;
        ctx.globalAlpha = L ? 1 : 0.14;
        if (L && !n.hub && n.last <= 3 && !this.reduced) {
          const ph = (t * 0.8 + n.r * 0.13) % 1;
          ctx.globalAlpha = (1 - ph) * 0.6; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(sx, sy, rs + 2 + ph * 9, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (n.hub) {
          ctx.fillStyle = this.surface || BG; ctx.beginPath(); ctx.arc(sx, sy, rs, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx, sy, rs * 0.42, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx, sy, rs, 0, Math.PI * 2); ctx.fill();
        }
        if (n.id === this.scope && !n.hub) { ctx.strokeStyle = '#3ddbd9'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, rs + 5, 0, Math.PI * 2); ctx.stroke(); }
        if (n.id === sel || pset.has(n.id) || n.id === hov) {
          ctx.strokeStyle = pset.has(n.id) ? '#4589ff' : '#f4f4f4'; ctx.lineWidth = n.id === hov && n.id !== sel ? 1 : 1.75;
          ctx.beginPath(); ctx.arc(sx, sy, rs + 4, 0, Math.PI * 2); ctx.stroke();
        }
      }
      {
        const priority = n => n.id === this.scope ? 0 : n.id === hov ? 1 : n.id === sel ? 2
          : pset.has(n.id) ? 3 : q && match(n) ? 4 : n.hub ? 5 : 6;
        const candidates = order.filter(n => priority(n) < 3 || (lit(n)
          && (n.hub || (!this.compact && (pset.has(n.id) || q || k > 1.7)))))
          .sort((a, b) => priority(a) - priority(b));
        // Share one label budget across hubs and items; selection must not label every neighbour.
        const occupied = [{ left: W - 64, top: H - 170, right: W, bottom: H }];
        const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        ctx.lineJoin = 'round'; ctx.textAlign = 'left'; ctx.globalAlpha = 1;
        let count = 0;
        for (const n of candidates) {
          if (count === (this.compact ? 4 : 6) || W < 96 || H < 32) break;
          const [sx, sy] = this.S(n), r = n.r * zr;
          if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
          const main = priority(n) < 3;
          ctx.font = `400 12px ${FONT}`;
          const maxWidth = Math.min(220, W - 80);
          let text = n.name;
          if (ctx.measureText(text).width > maxWidth) {
            const characters = Array.from(text);
            let low = 0, high = characters.length;
            while (low < high) {
              const mid = Math.ceil((low + high) / 2);
              if (ctx.measureText(characters.slice(0, mid).join('') + '…').width <= maxWidth) low = mid;
              else high = mid - 1;
            }
            text = characters.slice(0, low).join('') + '…';
          }
          const width = ctx.measureText(text).width;
          const positions = [[sx - width / 2, sy - r - 10], [sx - width / 2, sy + r + 22],
            [sx - r - width - 10, sy + 4], [sx + r + 10, sy + 4]];
          for (let [x, y] of positions) {
            x = clamp(x, 8, W - width - 8); y = clamp(y, 18, H - 8);
            const box = { left: x - 4, top: y - 15, right: x + width + 4, bottom: y + 6 };
            if (occupied.some(other => overlaps(box, other))) continue;
            occupied.push(box); count++;
            ctx.fillStyle = this.surface || '#262626'; ctx.globalAlpha = 0.9; ctx.fillRect(x - 3, y - 13, width + 6, 18);
            ctx.globalAlpha = 1;
            ctx.fillStyle = main ? '#f4f4f4' : '#c6c6c6'; ctx.fillText(text, x, y);
            break;
          }
        }
      }
    }
  }
  if (!customElements.get('atlas-graph')) customElements.define('atlas-graph', AtlasGraph);
})();
