/* Trusted DOM renderer; scene data never contributes executable markup. */
import { connectionGeometry, connectionRing } from './visualGeometry.js';
import { createPresenterVideo } from './visualVideo.js';

export const VISUAL_BUILD_INTERVAL_MS = 1600;
const SLIDE_WIDTH = 1600;
const SLIDE_HEIGHT = 900;
const AREA = { left: 80, top: 240, right: 1520, bottom: 800 };
const PRESENTER_SCALE = 2 / 3;
const ICON_DISC = 112;
const EASE = 'cubic-bezier(0.2, 0, 0.38, 0.9)';
const ENTRANCE_MS = 600;
const DRAW_MS = 700;
const STAGGER_MS = 90;
const TEXT_SIZES = ['xl', 'l', 'm', 's'];
// Official reversed artwork, without the construction grid; geometry is unchanged.
// https://www.ibm.com/design/language/4cd1ac2975364715d895c04784521ee9/8bar-neg.svg
const IBM_8BAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="57.6 61.7 1109.6 440.2" fill="#ffffff">
<rect x="57.6" y="473.9" width="215.8" height="28"/><rect x="57.6" y="415" width="215.8" height="28"/>
<rect x="119.2" y="356.2" width="92.5" height="28"/><rect x="119.2" y="297.3" width="92.5" height="28"/>
<rect x="119.2" y="238.5" width="92.5" height="28"/><rect x="119.2" y="179.7" width="92.5" height="28"/>
<rect x="57.6" y="120.8" width="215.8" height="28"/><rect x="57.6" y="62" width="215.8" height="28"/>
<path d="M304.2,473.9v28h227c29.1,0,55.8-10.6,76.2-28H304.2z"/>
<path d="M304.2,415v28h329c5-8.7,9-18.2,11.8-28H304.2z"/>
<polygon points="365.8,356.2 365.8,384.2 365.8,384.2 458.3,384.2 458.3,356.2"/>
<path d="M610.4,297.3H365.8v28h267.3C626.9,314.7,619.4,305.2,610.4,297.3z"/>
<path d="M365.8,238.5v28h244.6c9-8.1,16.5-17.7,22.7-28H365.8z"/>
<path d="M644.6,148.8c-2.8-9.8-6.7-19.3-11.8-28H304.2v28H644.6z"/>
<path d="M607.3,90c-20.5-17.4-47.1-28-76.2-28h-227v28H607.3z"/>
<polygon points="365.8,179.7 365.8,207.7 365.8,207.7 458.3,207.7 458.3,179.7"/>
<path d="M550.7,207.7h94.7c2.2-9,3.4-18.5,3.4-28h-98.1V207.7z"/>
<path d="M550.7,356.2v28h98.1c0-9.5-1.1-19.1-3.4-28H550.7z"/>
<rect x="674" y="473.6" width="154.1" height="28"/><rect x="674" y="414.7" width="154.1" height="28"/>
<rect x="735.7" y="355.9" width="92.5" height="28"/><rect x="735.7" y="297.1" width="92.5" height="28"/>
<rect x="735.7" y="238.2" width="92.5" height="28"/>
<rect x="1013.1" y="473.6" width="154.1" height="28"/><rect x="1013.1" y="414.7" width="154.1" height="28"/>
<rect x="1013.1" y="355.9" width="92.5" height="28"/><rect x="1013.1" y="297.1" width="92.5" height="28"/>
<polygon points="1013.1,266.2 1105.5,266.2 1105.5,238.2 1013.1,238.2 932.1,238.2 922.5,266.2 1003.5,266.2 1013.1,239.6"/>
<polygon points="1105.5,179.4 952.5,179.4 943,207.4 1105.5,207.4"/>
<polygon points="993.4,61.7 983.6,89.7 1167.2,89.7 1167.2,61.7"/>
<polygon points="920.6,501.3 930.4,473.6 910.8,473.6"/>
<polygon points="899.9,442.8 941.3,442.8 951.1,414.7 890,414.7"/>
<polygon points="879.1,383.9 962.1,383.9 971.9,355.9 869.3,355.9"/>
<polygon points="858.4,325.1 982.8,325.1 992.9,297.1 848.3,297.1"/>
<polygon points="909.1,238.2 828.1,238.2 828.1,239.6 837.6,266.2 918.6,266.2"/>
<polygon points="735.7,207.4 898.2,207.4 888.6,179.4 735.7,179.4"/>
<polygon points="963.2,148.6 1167.2,148.6 1167.2,120.5 973,120.5"/>
<polygon points="868.2,120.5 674,120.5 674,148.6 878,148.6"/>
<polygon points="847.7,61.7 674,61.7 674,89.7 857.5,89.7"/>
</svg>`;
const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const pad = value => String(value).padStart(2, '0');

export function visualBuildSteps(items) {
  const steps = [0];
  for (let index = 0; index < items.length; index++) {
    const current = items[index], next = items[index + 1];
    const sameCue = next && (typeof current.at === 'number' && current.at === next.at
      || current.cue && next.cue && current.cue.blockId === next.cue.blockId && current.cue.quote === next.cue.quote);
    if (!sameCue) steps.push(index + 1);
  }
  return steps;
}

const snap = (value, step = 8) => Math.round(value / step) * step;
const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
const separation = (a, b) => Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), a.y - (b.y + b.height), b.y - (a.y + a.height));
const withinArea = node => node.kind === 'image' || node.x >= AREA.left - 1 && node.y >= AREA.top - 1
  && node.x + node.width <= AREA.right + 1 && node.y + node.height <= AREA.bottom + 1;

/** An unlinked text node sitting inside a connected diagram (e.g. a lifecycle hub) is a centred label, not an edge caption. */
function hubText(node, nodes, connected) {
  if (node.kind !== 'text' || connected.has(node.id)) return false;
  const linked = nodes.filter(item => connected.has(item.id));
  if (linked.length < 3) return false;
  const xs = linked.map(item => item.x + item.width / 2), ys = linked.map(item => item.y + item.height / 2);
  const x = node.x + node.width / 2, y = node.y + node.height / 2;
  return x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys);
}

function relations(nodes) {
  const result = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      result.push(contains(a, b) ? 'contains' : contains(b, a) ? 'contained' : separation(a, b));
    }
  }
  return result;
}

/**
 * Connectors can only be straight when their subjects share centre lines. This snaps comparable peers to equal sizes,
 * shared rows/columns (icon rows align on their symbols) and even spacing on an 8px grid. Each step is kept only if it
 * preserves every separation and containment, so deliberate groupings never collapse.
 */
export function alignVisualNodes(nodes, links = []) {
  let layout = nodes.map(node => ({ ...node }));
  const linked = new Set(links.flatMap(link => [`${link.from}>${link.to}`, `${link.to}>${link.from}`]));
  const connected = new Set(links.flatMap(link => [link.from, link.to]));
  const hubs = new Set(nodes.filter(node => hubText(node, nodes, connected)).map(node => node.id));
  const edge = node => node.kind === 'text' && !connected.has(node.id) && !hubs.has(node.id);
  const lineY = node => node.kind === 'icon' ? node.y + ICON_DISC / 2 : node.y + node.height / 2;
  const lineX = node => edge(node) ? node.x : node.x + node.width / 2;
  const placeY = (node, value) => { node.y = node.kind === 'icon' ? value - ICON_DISC / 2 : value - node.height / 2; };
  const placeX = (node, value) => { node.x = edge(node) ? value : value - node.width / 2; };
  const peersOf = list => list.filter(node => node.kind !== 'image');
  const attempt = change => {
    const next = layout.map(node => ({ ...node }));
    change(next);
    next.forEach((node, index) => {
      if (!withinArea(layout[index])) return;
      node.x = Math.min(Math.max(node.x, AREA.left), AREA.right - node.width);
      node.y = Math.min(Math.max(node.y, AREA.top), AREA.bottom - node.height);
    });
    const before = relations(layout), after = relations(next);
    const kept = before.every((relation, index) => typeof relation === 'string' ? after[index] === relation
      : relation <= 0 || typeof after[index] === 'number' && after[index] >= Math.min(relation, 32));
    if (kept && layout.every((node, index) => !withinArea(node) || withinArea(next[index]))) layout = next;
  };
  const cluster = (list, value, place, axis) => {
    const peers = peersOf(list);
    const parent = peers.map((_, index) => index);
    const find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const a = peers[i], b = peers[j];
        if (axis === 'x' && edge(a) !== edge(b)) continue;
        const span = axis === 'y' ? Math.min(a.height, b.height) : Math.min(a.width, b.width);
        const tolerance = linked.has(`${a.id}>${b.id}`) ? Math.max(40, span / 2) : 40;
        if (Math.abs(value(a) - value(b)) <= tolerance) parent[find(i)] = find(j);
      }
    }
    const sets = new Map();
    peers.forEach((node, index) => { const root = find(index); sets.set(root, [...(sets.get(root) ?? []), node]); });
    for (const set of sets.values()) {
      const target = snap(set.reduce((sum, node) => sum + value(node), 0) / set.length);
      set.forEach(node => place(node, target));
    }
  };
  const distribute = (list, line, value, place) => {
    const sets = new Map();
    for (const node of peersOf(list)) {
      const key = Math.round(line(node));
      sets.set(key, [...(sets.get(key) ?? []), node]);
    }
    for (const set of sets.values()) {
      if (set.length < 3) continue;
      set.sort((a, b) => value(a) - value(b));
      const gaps = set.slice(1).map((node, index) => value(node) - value(set[index]));
      if (Math.min(...gaps) * 1.8 < Math.max(...gaps)) continue;
      const first = value(set[0]), last = value(set.at(-1));
      set.forEach((node, index) => place(node, snap(first + (last - first) * index / (set.length - 1))));
    }
  };
  attempt(next => {
    const sets = [];
    for (const node of peersOf(next)) {
      const set = sets.find(group => group[0].kind === node.kind
        && Math.abs(group[0].width - node.width) <= group[0].width * 0.25
        && Math.abs(group[0].height - node.height) <= group[0].height * 0.25);
      if (set) set.push(node); else sets.push([node]);
    }
    for (const set of sets) {
      const width = Math.max(16, snap(Math.max(...set.map(node => node.width)), 16));
      const height = Math.max(16, snap(Math.max(...set.map(node => node.height)), 16));
      for (const node of set) {
        const x = lineX(node), y = lineY(node);
        node.width = width; node.height = height;
        placeX(node, x); placeY(node, y);
      }
    }
  });
  attempt(next => cluster(next, lineY, placeY, 'y'));
  attempt(next => cluster(next, lineX, placeX, 'x'));
  attempt(next => distribute(next, lineY, lineX, placeX));
  attempt(next => distribute(next, lineX, lineY, placeY));
  return layout;
}

function createBackdrop(document) {
  const view = document.defaultView;
  const element = document.createElement('div');
  element.className = 'slide-backdrop';
  element.setAttribute('aria-hidden', 'true');
  const glow = document.createElement('div');
  glow.className = 'slide-backdrop__glow';
  const canvas = document.createElement('canvas');
  canvas.className = 'slide-backdrop__network';
  canvas.width = SLIDE_WIDTH;
  canvas.height = SLIDE_HEIGHT;
  element.append(glow, canvas);
  let context = null;
  try { context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null; } catch { context = null; }
  let seed = 7;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const points = Array.from({ length: 44 }, () => ({ x: random() * SLIDE_WIDTH, y: random() * SLIDE_HEIGHT,
    vx: (random() - 0.5) * 0.3, vy: (random() - 0.5) * 0.3, accent: random() < 0.18 }));
  const draw = () => {
    if (!context) return;
    context.clearRect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);
    context.lineWidth = 1;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i], b = points[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > 230) continue;
        context.strokeStyle = `rgba(120, 169, 255, ${(0.1 * (1 - distance / 230)).toFixed(3)})`;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
    }
    for (const point of points) {
      context.fillStyle = point.accent ? 'rgba(69, 137, 255, 0.55)' : 'rgba(141, 141, 141, 0.22)';
      context.fillRect(point.x - 3, point.y - 3, 6, 6);
    }
  };
  let frame = 0, running = false, live = false, visible = true;
  const step = () => {
    if (!running) return;
    for (const point of points) {
      point.x += point.vx; point.y += point.vy;
      if (point.x < 0 || point.x > SLIDE_WIDTH) point.vx *= -1;
      if (point.y < 0 || point.y > SLIDE_HEIGHT) point.vy *= -1;
    }
    draw();
    frame = view.requestAnimationFrame(step);
  };
  const update = () => {
    const run = live && visible && !document.hidden && !!context && typeof view?.requestAnimationFrame === 'function';
    if (run && !running) { running = true; frame = view.requestAnimationFrame(step); }
    else if (!run && running) { running = false; view.cancelAnimationFrame(frame); }
  };
  document.addEventListener('visibilitychange', update);
  draw();
  return {
    element,
    live(value) { live = value; update(); },
    visible(value) { visible = value; update(); },
    dispose() { live = false; update(); document.removeEventListener('visibilitychange', update); },
  };
}

let nextRenderer = 0;
export function createVisualRenderer(stage, status, _footerHost, options = {}) {
  const document = stage.ownerDocument;
  const view = document.defaultView;
  const rendererId = `visual-${++nextRenderer}`;
  stage.classList.add('visual-viewport');
  const slide = document.createElement('div');
  slide.className = 'visual-slide';
  const backdrop = createBackdrop(document);
  const layers = document.createElement('div');
  layers.className = 'slide-layers';
  const footer = document.createElement('footer');
  footer.className = 'slide-footer';
  const presentationTitle = document.createElement('span');
  const pageNumber = document.createElement('span');
  pageNumber.className = 'slide-footer__page';
  footer.append(presentationTitle, pageNumber);
  const progress = document.createElement('div');
  progress.className = 'slide-progress';
  progress.setAttribute('aria-hidden', 'true');
  const progressFill = document.createElement('span');
  progress.append(progressFill);
  slide.append(backdrop.element, layers, footer, progress);
  stage.replaceChildren(slide);
  const presenterVideo = createPresenterVideo(slide, { capture: options.captureVideo, report: options.onVideoState });
  const fit = () => {
    const width = stage.clientWidth, height = stage.clientHeight;
    const scale = width && height ? Math.min(width / SLIDE_WIDTH, height / SLIDE_HEIGHT) : 1;
    slide.style.transform = `translate(${(width - SLIDE_WIDTH * scale) / 2}px, ${(height - SLIDE_HEIGHT * scale) / 2}px) scale(${scale})`;
  };
  const resizer = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(fit) : null;
  resizer?.observe(stage);
  fit();
  const visibility = typeof view?.IntersectionObserver === 'function'
    ? new view.IntersectionObserver(entries => backdrop.visible(entries.some(entry => entry.isIntersecting))) : null;
  visibility?.observe(stage);
  let signature = '';
  let layer = null;
  let live = false;
  let wantsMotion = true;
  let previousRevealed = -1;
  let buildSteps = [0];
  let sceneRevision = 0;
  let openingDelay = 0;
  let renderedSection = null;
  let ring = null;
  let imageError = '';
  let packetError = '';
  const reveals = new Map();
  const animations = new Map();
  const loops = new Map();
  const motionPreference = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => !!motionPreference?.matches;
  const iconPaths = {
    person: 'M16 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM5 29v-4a11 8 0 0 1 22 0v4',
    worker: 'M16 3v4M12 3h8M5 8h22v18H5ZM10 14h2v3h-2ZM20 14h2v3h-2ZM11 22h10M1 14v7M31 14v7',
    document: 'M7 2h12l7 7v21H7ZM19 2v8h7M11 16h11M11 21h11M11 26h8',
    check: 'M27 8 12 24 5 17',
    system: 'M9 9h14v14H9ZM13 1v8M19 1v8M13 23v8M19 23v8M1 13h8M1 19h8M23 13h8M23 19h8',
    arrow: 'M3 16h25M19 7l9 9-9 9',
    boundary: 'M16 2 29 8v9c0 6-7 11-13 14C10 28 3 23 3 17V8ZM10 16l4 4 9-10',
  };
  function svgElement(tag, attributes = {}) {
    const element = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }
  function html(tag, className, text) {
    const element = document.createElementNS(XHTML, tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function cancelAnimations(element) {
    animations.get(element)?.forEach(animation => animation.cancel());
    animations.delete(element);
  }
  function stopLoop(element) { loops.get(element)?.cancel(); loops.delete(element); }
  function stopLoops() { for (const element of [...loops.keys()]) stopLoop(element); }
  function setLive() {
    live = wantsMotion && !reduced();
    slide.classList.toggle('visual-slide--live', live);
    backdrop.live(live);
    if (!live) stopLoops();
  }
  const reduceMotion = () => {
    if (reduced()) {
      for (const owner of [...animations.keys()]) cancelAnimations(owner);
      layers.querySelectorAll('.composition-visible').forEach(element => element.classList.add('composition-settled'));
    }
    setLive();
    syncLoops();
  };
  motionPreference?.addEventListener?.('change', reduceMotion);
  function showStatus() {
    status.textContent = packetError || imageError;
    status.hidden = !status.textContent;
  }
  function watchImage(image, message) {
    const revision = sceneRevision;
    image.onerror = () => {
      if (revision !== sceneRevision) return;
      imageError = message;
      showStatus();
    };
    image.onload = () => {
      if (revision !== sceneRevision) return;
      imageError = '';
      showStatus();
    };
  }
  function animate(owner, target, frames, timing) {
    if (typeof target?.animate !== 'function') return;
    const animation = target.animate(frames, { fill: 'backwards', ...timing });
    const active = animations.get(owner) ?? new Set();
    active.add(animation);
    animations.set(owner, active);
    animation.onfinish = () => { active.delete(animation); };
  }
  function travel(token, path, delay) {
    const length = typeof path.getTotalLength === 'function' ? path.getTotalLength() : 0;
    if (!length || typeof token.animate !== 'function') return { cancel() {} };
    const frames = Array.from({ length: 41 }, (_, index) => {
      const point = path.getPointAtLength(length * index / 40);
      return { offset: index / 40 * 0.8, transform: `translate(${point.x}px, ${point.y}px)`,
        opacity: index < 4 ? index / 4 : index > 36 ? (40 - index) / 4 : 1 };
    });
    frames.push({ offset: 1, transform: frames.at(-1).transform, opacity: 0 });
    const duration = Math.min(3200, Math.max(1400, length * 4)) / 0.8;
    return token.animate(frames, { duration, delay, iterations: Infinity, easing: 'linear' });
  }
  function orbit(current, delay) {
    const length = typeof current.track.getTotalLength === 'function' ? current.track.getTotalLength() : 0;
    if (!length || typeof current.dot.animate !== 'function') return { cancel() {} };
    const frames = Array.from({ length: 97 }, (_, index) => {
      const point = current.track.getPointAtLength(length * (current.clockwise ? index / 96 : 1 - index / 96));
      return { transform: `translate(${point.x}px, ${point.y}px)`, opacity: 1 };
    });
    return current.dot.animate(frames, { duration: 8000, delay, iterations: Infinity, easing: 'linear' });
  }
  function syncLoops(delays = new Map()) {
    for (const [element, parts] of reveals) {
      if (!parts.token) continue;
      if (!live || !element.classList.contains('composition-visible')) { stopLoop(element); continue; }
      if (!loops.has(element)) loops.set(element, travel(parts.token, parts.path, delays.get(element) ?? 0));
    }
    if (!ring) return;
    const complete = ring.links.length > 0 && ring.links.every(group => group.classList.contains('composition-visible'));
    if (!live || !complete) stopLoop(ring.dot);
    else if (!loops.has(ring.dot)) loops.set(ring.dot, orbit(ring, delays.get(ring) ?? 0));
  }
  function setReveals(revealed, motion = true) {
    if (!layer) return;
    const previousStep = buildSteps.indexOf(previousRevealed);
    const nextStep = buildSteps.indexOf(revealed);
    const smooth = motion && !reduced() && nextStep >= 0 && nextStep === previousStep + 1
      && (previousRevealed === -1 || previousStep >= 0);
    const settle = !motion || reduced() || revealed !== previousRevealed && !smooth;
    if (settle) for (const owner of [...animations.keys()]) cancelAnimations(owner);
    const opening = previousRevealed === -1 ? openingDelay : 0;
    const elements = [...layer.querySelectorAll('[data-reveal]')];
    const nodeCount = elements.filter(element => reveals.get(element)?.node
      && Number(element.getAttribute('data-reveal')) <= revealed && !element.classList.contains('composition-visible')).length;
    const loopDelays = new Map();
    let nodeIndex = 0, linkIndex = 0;
    for (const element of elements) {
      const visible = Number(element.getAttribute('data-reveal')) <= revealed;
      const changed = element.classList.contains('composition-visible') !== visible;
      if (!changed) {
        if (settle && visible) element.classList.add('composition-settled');
        continue;
      }
      cancelAnimations(element);
      element.classList.toggle('composition-visible', visible);
      element.classList.toggle('composition-settled', !smooth);
      element.setAttribute('aria-hidden', String(!visible));
      if (!visible || !smooth) continue;
      const parts = reveals.get(element);
      if (parts?.node) {
        const delay = opening + nodeIndex++ * STAGGER_MS;
        const entrance = parts.node.entrance || 'rise';
        const transform = { fade: 'none', rise: 'translateY(24px)', left: 'translateX(-32px)',
          right: 'translateX(32px)', scale: 'scale(0.94)', wipe: 'none' }[entrance] ?? 'translateY(24px)';
        animate(element, element, [
          { opacity: 0, transform, clipPath: entrance === 'wipe' ? 'inset(0 100% 0 0)' : 'inset(0)' },
          { opacity: 1, transform: 'none', clipPath: 'inset(0)' },
        ], { duration: ENTRANCE_MS, delay, easing: EASE });
        element.style.setProperty('--emphasis-delay', `${delay + 420}ms`);
        if (parts.ripple) animate(element, parts.ripple, [{ transform: 'scale(1)', opacity: 0.6 }, { transform: 'scale(1.8)', opacity: 0 }],
          { duration: 1100, delay: delay + 360, easing: 'cubic-bezier(0, 0, 0.38, 0.9)', fill: 'none' });
      } else if (parts?.draw) {
        const delay = opening + (parts.endpointReveal > previousRevealed ? nodeCount * STAGGER_MS + 420 : 0) + linkIndex++ * 160;
        animate(element, parts.draw, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: DRAW_MS, delay, easing: EASE });
        if (parts.arrow) animate(element, parts.arrow, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: delay + DRAW_MS - 140 });
        if (parts.label) animate(element, parts.label, [{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: delay + DRAW_MS - 80 });
        loopDelays.set(element, delay + DRAW_MS + 160);
        if (ring?.links.includes(element)) loopDelays.set(ring, Math.max(loopDelays.get(ring) ?? 0, delay + DRAW_MS + 240));
      } else if (parts?.fade) {
        animate(element, element, [{ opacity: 0 }, { opacity: 1 }], { duration: ENTRANCE_MS, delay: opening, easing: EASE });
      }
    }
    previousRevealed = revealed;
    syncLoops(loopDelays);
  }
  function eyebrow(label, page) {
    const element = html('p', 'slide-eyebrow');
    if (page > 0) element.append(html('span', 'slide-eyebrow__number', pad(page)));
    if (label) element.append(html('span', '', label));
    return element;
  }
  function slideHeader(scene, page) {
    const header = html('header', 'slide-header');
    header.append(eyebrow(scene.composition?.label, page), html('h1', 'slide-title', scene.title));
    if (scene.subtitle) header.append(html('p', 'slide-subtitle', scene.subtitle));
    return header;
  }
  function glyph(icon) {
    if (!iconPaths[icon]) return null;
    const element = svgElement('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true', class: 'visual-node__icon' });
    element.append(svgElement('path', { d: iconPaths[icon] }));
    return element;
  }
  function nodeElement(scene, node, linked) {
    const size = TEXT_SIZES.includes(node.size) ? node.size : 'm';
    const element = html('div', `visual-node visual-node--${node.kind} visual-tone--${node.tone}`
      + (node.kind === 'text' ? ` visual-text--${size}${linked ? ' visual-node--centred' : ''}` : ''));
    let ripple = null;
    if (node.kind === 'image') {
      if (/^https:\/\//i.test(scene.imageUrl)) {
        const image = html('img');
        image.src = scene.imageUrl;
        image.alt = scene.imageAlt;
        image.referrerPolicy = 'no-referrer';
        watchImage(image, 'The scene illustration could not be loaded. Reload to retry.');
        element.append(image);
      }
      return { element, ripple };
    }
    if (node.kind === 'icon') {
      const disc = html('span', 'visual-node__disc');
      ripple = html('span', 'visual-node__ripple');
      disc.append(ripple, glyph(node.icon) ?? html('span', 'visual-node__dot'));
      element.append(disc);
    } else if (node.kind === 'panel' && node.icon) {
      const icon = glyph(node.icon);
      if (icon) element.append(icon);
    }
    if (node.kicker) element.append(html('p', 'visual-node__kicker', node.kicker));
    if (node.label) {
      const label = html('h2');
      if (node.emphasis) label.append(html('span', `visual-emphasis visual-emphasis--${node.emphasis}`, node.label));
      else label.textContent = node.label;
      element.append(label);
    }
    if (node.detail) element.append(html('p', 'visual-node__detail', node.detail));
    return { element, ripple };
  }
  function arrowHead(end, tip) {
    if (!end || !tip) return null;
    const dx = tip[0] - end[0], dy = tip[1] - end[1];
    const length = Math.hypot(dx, dy);
    if (length < 4) return null;
    const ux = dx / length, uy = dy / length;
    const back = [tip[0] - ux * 24, tip[1] - uy * 24];
    const corners = [tip, [back[0] - uy * 13, back[1] + ux * 13], [back[0] + uy * 13, back[1] - ux * 13]];
    return svgElement('path', { d: `M${corners.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`, class: 'composition-arrow' });
  }
  function composed(scene, page, revealed, motion) {
    const composition = scene.composition;
    const presenter = !!scene.presenterLayout;
    layer.classList.add('slide-layer--composed');
    layer.append(slideHeader(scene, page));
    const svg = svgElement('svg', { viewBox: `0 0 ${SLIDE_WIDTH} ${SLIDE_HEIGHT}`, role: 'group', 'aria-label': scene.title });
    svg.classList.add('composition');
    const defs = svgElement('defs');
    const scale = presenter ? PRESENTER_SCALE : 1;
    const offsetY = presenter ? AREA.top + (AREA.bottom - AREA.top) * (1 - scale) / 2 - AREA.top * scale : 0;
    const content = svgElement('g', { transform: `translate(${AREA.left - AREA.left * scale} ${offsetY}) scale(${scale})` });
    const reference = svgElement('rect', { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, fill: 'none', 'aria-hidden': 'true' });
    const ringLayer = svgElement('g');
    const connections = svgElement('g');
    content.append(reference, ringLayer, connections);
    svg.append(defs, content);
    const placed = alignVisualNodes(composition.nodes, composition.links);
    const connected = new Set(composition.links.flatMap(link => [link.from, link.to]));
    const centred = new Set(placed.filter(node => connected.has(node.id) || hubText(node, placed, connected)).map(node => node.id));
    const subjects = new Map();
    placed.forEach((node, index) => {
      const holder = svgElement('foreignObject', { x: node.x, y: node.y, width: node.width, height: node.height, 'data-reveal': node.reveal });
      holder.classList.add('composition-reveal', 'composition-subject');
      if (connected.has(node.id)) holder.classList.add('composition-linked');
      holder.style.setProperty('--float-delay', `${-((index * 1.7) % 6)}s`);
      const { element, ripple } = nodeElement(scene, node, centred.has(node.id));
      holder.append(element);
      reveals.set(holder, { node, ripple });
      subjects.set(node.id, element);
      content.append(holder);
    });
    layer.append(svg);
    const frame = reference.getBoundingClientRect();
    const unit = frame.width / SLIDE_WIDTH;
    const measure = element => {
      if (!unit) return null;
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height ? { x: (rect.left - frame.left) / unit, y: (rect.top - frame.top) / unit,
        width: rect.width / unit, height: rect.height / unit } : null;
    };
    const nodes = placed.map(node => {
      const element = subjects.get(node.id);
      const box = { x: node.x, y: node.y, width: node.width, height: node.height };
      const parts = [...element.children].map(measure).filter(Boolean);
      const left = Math.min(...parts.map(rect => rect.x)), top = Math.min(...parts.map(rect => rect.y));
      const union = parts.length ? { x: left, y: top, width: Math.max(...parts.map(rect => rect.x + rect.width)) - left,
        height: Math.max(...parts.map(rect => rect.y + rect.height)) - top } : box;
      const solid = node.kind === 'panel' || node.kind === 'image' || !parts.length;
      const bounds = solid ? box : union;
      const lead = node.kind === 'icon' ? element.querySelector('.visual-node__disc')
        : node.kind === 'text' ? element.querySelector('h2') : null;
      return { id: node.id, bounds, anchor: lead ? measure(lead) ?? bounds : bounds, obstacles: solid ? [bounds] : parts };
    });
    const geometryRing = connectionRing(composition.links, nodes);
    ring = null;
    if (geometryRing) {
      const arcs = composition.links.filter(link => link.route === 'arc');
      const members = new Set(arcs.flatMap(link => [link.from, link.to]));
      const maskId = `${rendererId}-${sceneRevision}-ring`;
      const mask = svgElement('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
      mask.append(svgElement('rect', { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, fill: '#fff' }));
      for (const node of nodes.filter(node => members.has(node.id))) {
        for (const rect of node.obstacles) mask.append(svgElement('rect', { x: rect.x - 20, y: rect.y - 20, width: rect.width + 40, height: rect.height + 40, fill: '#000' }));
      }
      defs.append(mask);
      const group = svgElement('g', { mask: `url(#${maskId})`,
        'data-reveal': Math.min(...placed.filter(node => members.has(node.id)).map(node => node.reveal)) });
      group.classList.add('composition-reveal', 'composition-ring', `visual-tone--${arcs[0]?.tone ?? 'blue'}`);
      const track = svgElement('path', { d: geometryRing.path, class: 'composition-ring__track' });
      const dot = svgElement('circle', { r: 10, class: 'composition-ring__dot' });
      group.append(track, dot);
      ringLayer.append(group);
      reveals.set(group, { fade: true });
      ring = { track, dot, clockwise: geometryRing.clockwise, links: [] };
    }
    composition.links.forEach((link, index) => {
      const from = nodes.find(node => node.id === link.from), to = nodes.find(node => node.id === link.to);
      if (!from || !to) throw new Error('A visual connection is missing its source or target.');
      const fanOut = composition.links.filter(other => other.from === link.from && other.route !== 'arc').length > 1;
      const fanIn = composition.links.filter(other => other.to === link.to && other.route !== 'arc').length > 1;
      const fan = composition.links.filter(other => other.route !== 'arc' && (fanOut ? other.from === link.from : fanIn && other.to === link.to));
      const siblings = fan.map(other => nodes.find(node => node.id === (fanOut ? other.to : other.from))).filter(Boolean);
      const geometry = connectionGeometry(from, to, link, nodes, geometryRing, fanOut ? 'from' : fanIn ? 'to' : null, siblings);
      const maskId = `${rendererId}-${sceneRevision}-draw-${index}`;
      const mask = svgElement('mask', { id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
      const draw = svgElement('path', { d: geometry.path, class: 'composition-draw', pathLength: 1 });
      mask.append(draw);
      defs.append(mask);
      const group = svgElement('g', { 'data-reveal': link.reveal });
      group.classList.add('composition-reveal', `visual-tone--${link.tone}`, `composition-link--${link.style}`);
      const path = svgElement('path', { d: geometry.path, class: 'composition-link', mask: `url(#${maskId})` });
      group.append(path);
      const arrow = arrowHead(geometry.end, geometry.tip);
      if (arrow) group.append(arrow);
      let token = null;
      if (link.motion === 'flow') {
        token = svgElement('g', { class: 'composition-token' });
        token.append(svgElement('circle', { r: 20, class: 'composition-token__halo' }), svgElement('circle', { r: 8 }));
        group.append(token);
      }
      const label = link.label ? svgElement('text', { x: geometry.label.x, y: geometry.label.y,
        'text-anchor': geometry.label.anchor, class: 'composition-link-label' }) : null;
      if (label) { label.textContent = link.label; group.append(label); }
      const endpointReveal = Math.max(...placed.filter(node => node.id === link.from || node.id === link.to).map(node => node.reveal));
      reveals.set(group, { draw, path, arrow, token, label, endpointReveal });
      if (ring && geometry.route === 'ring') ring.links.push(group);
      connections.append(group);
    });
    setReveals(revealed, motion);
  }
  function titleScene(scene, page) {
    const treatment = scene.composition?.imageTreatment;
    layer.classList.add('slide-layer--title');
    if (treatment) {
      layer.classList.add(`slide-layer--image-${treatment}`);
      const image = html('img', 'slide-image');
      image.alt = scene.imageAlt;
      image.referrerPolicy = 'no-referrer';
      if (/^https:\/\//i.test(scene.imageUrl)) image.src = scene.imageUrl;
      else { imageError = 'The header image is not available.'; showStatus(); }
      watchImage(image, 'The header image could not be loaded. Reload to retry.');
      layer.append(image);
    }
    const content = html('div', 'slide-title-block');
    content.append(eyebrow(scene.composition?.label, page), html('h1', 'slide-display', scene.title), html('span', 'slide-rule'));
    if (scene.subtitle) content.append(html('p', 'slide-lede', scene.subtitle));
    layer.append(content);
  }
  /** Wraps each cued phrase in a mark that the narration switches on; the words themselves stay visible throughout. */
  function emphasised(tag, className, text, phrases, kind, used) {
    const element = html(tag, className);
    const marks = phrases.filter(phrase => !used.has(phrase.reveal) && phrase.label && text.includes(phrase.label))
      .map(phrase => ({ ...phrase, start: text.indexOf(phrase.label) })).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const mark of marks) {
      if (mark.start < cursor) continue;
      used.add(mark.reveal);
      element.append(document.createTextNode(text.slice(cursor, mark.start)));
      const span = html('span', `visual-emphasis visual-emphasis--${kind} slide-close__mark`, mark.label);
      span.setAttribute('data-emphasis-reveal', String(mark.reveal));
      element.append(span);
      cursor = mark.start + mark.label.length;
    }
    element.append(document.createTextNode(text.slice(cursor)));
    return element;
  }
  function setCloseMarks(revealed, opening = false) {
    layer?.querySelectorAll('[data-emphasis-reveal]').forEach(mark => {
      const on = Number(mark.getAttribute('data-emphasis-reveal')) <= revealed;
      if (on && !mark.classList.contains('slide-close__mark--on')) mark.style.setProperty('--emphasis-delay', opening ? '1200ms' : '120ms');
      mark.classList.toggle('slide-close__mark--on', on);
    });
  }
  /** The end page: always full frame and centred, with the slide master's own sign-off. */
  function closeScene(scene, revealed) {
    layer.classList.add('slide-layer--close');
    const content = html('div', 'slide-close');
    const phrases = scene.items.map((item, index) => ({ label: item.label, reveal: index + 1 }));
    const used = new Set();
    const statement = emphasised('h1', 'slide-close__statement', scene.title, phrases, 'highlight', used);
    if (scene.subtitle) content.append(emphasised('p', 'slide-close__setup', scene.subtitle, phrases, 'underline', used));
    content.append(statement, html('p', 'slide-close__thanks', 'Thank you'));
    layer.append(content);
    if (scene.brandMark === 'ibm-8bar') {
      const logo = html('img', 'slide-close__brand');
      logo.alt = 'IBM eight-bar logo';
      logo.src = `data:image/svg+xml,${encodeURIComponent(IBM_8BAR)}`;
      layer.append(logo);
    }
    setCloseMarks(revealed, true);
  }
  function illustration(artwork) {
    const svg = svgElement('svg', { viewBox: '0 0 1600 900', preserveAspectRatio: 'xMidYMid slice', role: 'img', 'aria-label': artwork.description });
    svg.classList.add('artwork');
    artwork.shapes.forEach(shape => {
      if (!['circle', 'rect', 'path'].includes(shape.kind) || !['teal', 'blue', 'purple', 'neutral'].includes(shape.tone)) return;
      const element = svgElement(shape.kind, { opacity: shape.opacity });
      element.classList.add(`artwork__${shape.tone}`);
      if (shape.kind === 'circle') {
        element.setAttribute('cx', String(shape.x));
        element.setAttribute('cy', String(shape.y));
        element.setAttribute('r', String(shape.radius));
      } else if (shape.kind === 'rect') {
        for (const key of ['x', 'y', 'width', 'height']) element.setAttribute(key, String(shape[key]));
        element.setAttribute('rx', String(shape.radius));
      } else {
        if (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/.test(shape.d)) return;
        element.setAttribute('d', shape.d);
      }
      svg.append(element);
    });
    return svg;
  }
  function legacy(scene, revealed) {
    const container = html('div', `scene scene--${scene.template} scene--${scene.layout || (scene.template === 'title' ? 'hero' : 'diagram')}${scene.artwork ? ' scene--illustrated' : ''}`);
    const canvas = html('div', 'visual-canvas');
    container.append(canvas);
    if (scene.artwork) canvas.append(illustration(scene.artwork));
    if (scene.template === 'image' && /^https:\/\//i.test(scene.imageUrl)) {
      const image = html('img', 'scene-image');
      image.src = scene.imageUrl;
      image.alt = scene.imageAlt;
      image.referrerPolicy = 'no-referrer';
      watchImage(image, 'The scene image could not be loaded.');
      canvas.append(image);
    }
    const content = html('div', 'scene-content');
    content.append(html('p', 'scene-eyebrow', scene.template === 'title' ? 'Perspective' : {
      concept: 'Connected ideas', steps: 'How it works', comparison: 'The distinction', statistic: 'In focus', image: 'A closer look',
    }[scene.template] || ''), html('h1', '', scene.title));
    if (scene.subtitle) content.append(html('p', 'subtitle', scene.subtitle));
    const items = html('div', 'items');
    scene.items.forEach((item, index) => {
      const visible = index < revealed;
      const card = html('div', `item${visible ? ' item--visible' : ''}`);
      card.setAttribute('aria-hidden', String(!visible));
      const marker = html('span', 'item__marker', pad(index + 1));
      marker.setAttribute('aria-hidden', 'true');
      card.append(marker, html('h2', '', item.label), html('p', '', item.detail));
      items.append(card);
    });
    if (scene.items.length) content.append(items);
    canvas.append(content);
    layer.append(container);
  }
  // Moving into a new script section holds a slightly longer cross-fade (about one second) as a pause between sections.
  function replaceLayer(transition, hasScene, sectionChange) {
    const previous = layer;
    layer = null;
    if (previous) {
      if (transition && typeof previous.animate === 'function') {
        previous.classList.add('slide-layer--leaving');
        previous.setAttribute('aria-hidden', 'true');
        const exit = previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: sectionChange ? 500 : 400, easing: EASE, fill: 'forwards' });
        exit.onfinish = () => previous.remove();
        exit.oncancel = () => previous.remove();
      } else previous.remove();
    }
    if (!hasScene) return;
    layer = html('div', 'slide-layer');
    layers.append(layer);
    if (transition && typeof layer.animate === 'function') {
      layer.animate([{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }],
        { duration: sectionChange ? 700 : ENTRANCE_MS, delay: sectionChange ? 300 : 200, easing: EASE, fill: 'backwards' });
    }
  }
  function render(packet) {
    if (!packet || typeof packet !== 'object') return;
    const scene = packet.scene;
    const page = packet.page > 0 ? packet.page : 0;
    const total = packet.total > 0 ? packet.total : 0;
    const key = JSON.stringify({ scene, page });
    if (signature !== key) { sceneRevision++; imageError = ''; }
    packetError = packet.error || '';
    showStatus();
    const presenter = !!scene?.presenterLayout && scene.template !== 'close';
    presenterVideo.update(presenter, packet.video);
    slide.classList.toggle('visual-slide--presenter', presenter);
    presentationTitle.textContent = packet.presentationTitle || '';
    pageNumber.textContent = total && page ? `${pad(page)} / ${pad(total)}` : '';
    footer.hidden = !scene;
    progress.hidden = !scene || !total || !page;
    progressFill.style.transform = `scaleX(${total ? Math.min(1, page / total) : 0})`;
    wantsMotion = packet.animate !== false;
    setLive();
    if (signature === key) {
      if (scene?.template === 'close') { setCloseMarks(packet.revealed); return; }
      if (scene?.composition) { setReveals(packet.revealed, wantsMotion); return; }
      layer?.querySelectorAll('.item').forEach((item, index) => {
        const visible = index < packet.revealed;
        item.classList.toggle('item--visible', visible);
        item.setAttribute('aria-hidden', String(!visible));
      });
      return;
    }
    signature = key;
    for (const owner of [...animations.keys()]) cancelAnimations(owner);
    stopLoops();
    reveals.clear();
    ring = null;
    previousRevealed = -1;
    buildSteps = visualBuildSteps(scene?.items ?? []);
    const transition = live && !!layer && !!scene;
    const section = Number.isInteger(scene?.section) ? scene.section : null;
    const sectionChange = transition && section !== null && renderedSection !== null && section !== renderedSection;
    renderedSection = section;
    openingDelay = transition ? sectionChange ? 420 : 320 : 0;
    replaceLayer(transition, !!scene, sectionChange);
    if (!scene) return;
    if (scene.template === 'close') {
      closeScene(scene, packet.revealed);
      return;
    }
    if (scene.composition?.imageTreatment || scene.template === 'title' && scene.composition?.nodes.length === 0) {
      titleScene(scene, page);
      return;
    }
    if (scene.composition) {
      composed(scene, page, packet.revealed, wantsMotion);
      return;
    }
    legacy(scene, packet.revealed);
  }
  render.disconnectVideo = message => presenterVideo.disconnect(message);
  render.dispose = () => {
    sceneRevision++;
    motionPreference?.removeEventListener?.('change', reduceMotion);
    for (const owner of [...animations.keys()]) cancelAnimations(owner);
    stopLoops();
    reveals.clear();
    resizer?.disconnect();
    visibility?.disconnect();
    backdrop.dispose();
    presenterVideo.dispose();
    slide.remove();
    stage.classList.remove('visual-viewport');
  };
  return render;
}

if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-athena-visual-output')) {
    const status = document.getElementById('status');
    let clientId = '';
    let requestId = '';
    let feedbackSequence = 0;
    const render = createVisualRenderer(document.getElementById('stage'), status, document.body, {
      captureVideo: true,
      onVideoState: video => {
        const reportedClient = clientId;
        const sequence = ++feedbackSequence;
        void fetch('./video-status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId, requestId: video.requestId, sequence, status: video.status, error: video.error }),
        }).then(response => {
          if (response.status === 409) return;
          if (!response.ok) throw new Error('Camera status was not acknowledged by Athena.');
        }).catch(error => {
          if (sequence !== feedbackSequence || video.requestId !== requestId || reportedClient !== clientId) return;
          console.error('[Visual output] Camera status failed:', error);
          render.disconnectVideo('Camera stopped because Athena could not confirm the output connection. Retry from the script toolbar.');
          events.close();
          status.hidden = false;
          status.textContent = 'Camera stopped: its connection could not be confirmed. Reopen browser visuals and retry Camera.';
        });
      },
    });
    const events = new EventSource('./events');
    events.onmessage = event => {
      try {
        const packet = JSON.parse(event.data);
        clientId = packet.videoClientId || '';
        requestId = packet.video?.requestId || '';
        render(packet);
      } catch (error) {
        console.error('[Visual output] Invalid presentation update:', error);
        render.disconnectVideo('Camera stopped because the presentation update could not be read.');
        status.hidden = false; status.textContent = 'The presentation update could not be read.';
      }
    };
    events.onerror = () => {
      render.disconnectVideo('Camera stopped because Athena disconnected. Reconnect and retry Camera from the script toolbar.');
      status.hidden = false;
      status.textContent = 'Presentation disconnected. The last visual is held; return to Athena to reconnect.';
    };
    window.addEventListener('pagehide', () => { events.close(); render.dispose(); }, { once: true });
}
