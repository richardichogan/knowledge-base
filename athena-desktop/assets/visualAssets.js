// Trusted vector illustrations for script visuals. Each asset is plain data (shape, geometry, paint, tone) that the
// renderer turns into SVG with DOM APIs; compositions only ever name an asset id, never supply markup.
const SVG_NS = 'http://www.w3.org/2000/svg';
const round = value => Math.round(value * 10) / 10;

const part = (shape, attrs, options = {}) => ({ shape, attrs, ...options });
const rect = (x, y, width, height, rx = 0, options) => part('rect', rx ? { x, y, width, height, rx } : { x, y, width, height }, options);
const circle = (cx, cy, r, options) => part('circle', { cx, cy, r }, options);
const line = (x1, y1, x2, y2, options) => part('line', { x1, y1, x2, y2 }, { paint: 'line', ...options });
const path = (d, options) => part('path', { d }, options);
const group = (parts, options = {}) => ({ shape: 'g', parts, ...options });

// Four-point sparkle with pinched sides.
const star = (cx, cy, r) => {
  const k = r * 0.14;
  return `M${cx} ${cy - r} Q${cx + k} ${cy - k} ${cx + r} ${cy} Q${cx + k} ${cy + k} ${cx} ${cy + r} Q${cx - k} ${cy + k} ${cx - r} ${cy} Q${cx - k} ${cy - k} ${cx} ${cy - r} Z`;
};

const gear = (cx, cy, outer, inner, teeth, phase = 0) => {
  const step = (Math.PI * 2) / teeth, base = step * 0.3, tip = step * 0.17;
  const point = (radius, angle) => `${round(cx + radius * Math.cos(angle + phase))} ${round(cy + radius * Math.sin(angle + phase))}`;
  let d = `M${point(inner, -Math.PI / 2 - base)}`;
  for (let i = 0; i < teeth; i += 1) {
    const centre = i * step - Math.PI / 2;
    d += ` L${point(outer, centre - tip)} L${point(outer, centre + tip)} L${point(inner, centre + base)}`
      + ` A${inner} ${inner} 0 0 1 ${point(inner, centre + step - base)}`;
  }
  return `${d} Z`;
};

// One isometric slab: an opaque silhouette, two shaded sides and a top face.
const slab = (top, face) => group([
  path(`M120 ${top} L204 ${top + 36} V${top + 50} L120 ${top + 86} L36 ${top + 50} V${top + 36} Z`, { paint: 'ink' }),
  path(`M36 ${top + 36} V${top + 50} L120 ${top + 86} V${top + 72} Z`, { paint: 'shade' }),
  path(`M204 ${top + 36} V${top + 50} L120 ${top + 86} V${top + 72} Z`, { paint: 'tint' }),
  path(`M120 ${top} L204 ${top + 36} L120 ${top + 72} L36 ${top + 36} Z`, { paint: face }),
]);

// paint: solid | soft | line | ink | inkline | shade | tint. tone overrides the node tone for one part.
// draw strokes on with the entrance; dash + motion keeps a dashed line flowing; motion spins or twinkles a group about
// its origin (the spinning gear pair keeps its 12:7 tooth ratio in CSS).
export const VISUAL_ASSETS = {
  foundation: { width: 240, height: 240, parts: [
    rect(14, 194, 212, 22, 6),
    rect(28, 172, 184, 18, 5, { paint: 'soft' }),
    rect(46, 94, 26, 74, 7, { paint: 'soft' }), rect(82, 94, 26, 74, 7, { paint: 'soft' }),
    rect(132, 94, 26, 74, 7, { paint: 'soft' }), rect(168, 94, 26, 74, 7, { paint: 'soft' }),
    rect(30, 70, 180, 18, 6, { paint: 'soft' }),
    group([path('M120 14 L220 62 H20 Z'), circle(120, 48, 8, { paint: 'ink' })]),
  ] },
  'workforce-pair': { width: 360, height: 240, parts: [
    rect(34, 210, 292, 12, 6, { tone: 'teal' }),
    group([
      circle(100, 78, 34, { tone: 'purple' }),
      path('M44 202 C44 150 70 128 100 128 C130 128 156 150 156 202 Z', { paint: 'soft', tone: 'purple', w: 4 }),
    ]),
    group([circle(166, 170, 15, { paint: 'line', tone: 'teal', w: 5, draw: true }), circle(194, 170, 15, { paint: 'line', tone: 'teal', w: 5, draw: true })]),
    group([
      line(260, 46, 260, 28, { tone: 'blue', w: 4 }), circle(260, 22, 8, { tone: 'blue' }),
      rect(226, 46, 68, 60, 16, { tone: 'blue' }),
      circle(246, 76, 6, { paint: 'ink' }), circle(274, 76, 6, { paint: 'ink' }),
      rect(206, 118, 108, 84, 20, { paint: 'soft', tone: 'blue', w: 4 }),
      rect(240, 146, 40, 28, 8, { paint: 'line', tone: 'blue', w: 4 }),
    ]),
  ] },
  copilot: { width: 240, height: 240, parts: [
    path('M48 34 H192 A24 24 0 0 1 216 58 V138 A24 24 0 0 1 192 162 H114 L72 204 V162 H48 A24 24 0 0 1 24 138 V58 A24 24 0 0 1 48 34 Z', { paint: 'soft', w: 5 }),
    line(54, 78, 150, 78, { w: 7, draw: true }),
    line(54, 106, 176, 106, { w: 7, draw: true }),
    line(54, 134, 118, 134, { w: 7, draw: true }),
    group([path(star(206, 40, 30), { tone: 'teal' })], { motion: 'twinkle', origin: [206, 40] }),
  ] },
  agent: { width: 240, height: 240, parts: [
    path('M120 16 L208 68 V172 L120 224 L32 172 V68 Z', { paint: 'soft', w: 5 }),
    group([circle(120, 120, 62, { paint: 'line', dash: 'dashes', w: 3 })], { motion: 'spin', origin: [120, 120] }),
    line(120, 120, 120, 58, { w: 4, draw: true }), line(120, 120, 173.7, 151, { w: 4, draw: true }), line(120, 120, 66.3, 151, { w: 4, draw: true }),
    circle(120, 58, 12), circle(173.7, 151, 12), circle(66.3, 151, 12),
    circle(120, 120, 22), circle(120, 120, 8, { paint: 'ink' }),
  ] },
  // Equal tooth pitch (12 and 7 teeth on pitch radii 71 and 41.4) keeps the teeth meshing while the pair turns 12:7.
  automation: { width: 240, height: 240, parts: [
    group([
      path(gear(92, 100, 80, 62, 12), { paint: 'soft', w: 5 }),
      circle(92, 100, 30, { paint: 'ink' }), circle(92, 100, 30, { paint: 'line', w: 5 }), circle(92, 100, 10),
    ], { motion: 'spin', origin: [92, 100] }),
    group([
      path(gear(171.5, 179.5, 50.4, 32.4, 7, 0.1122), { paint: 'soft', w: 5 }),
      circle(171.5, 179.5, 14, { paint: 'ink' }), circle(171.5, 179.5, 14, { paint: 'line', w: 4 }),
    ], { motion: 'spin-reverse', origin: [171.5, 179.5] }),
  ] },
  system: { width: 240, height: 240, parts: [
    rect(20, 24, 200, 192, 22, { paint: 'line', w: 5, draw: true }),
    line(58, 58, 58, 182, { w: 4, draw: true }),
    group([rect(84, 46, 110, 36, 12, { paint: 'soft' }), line(58, 64, 84, 64, { w: 4 }), circle(58, 64, 9), circle(102, 64, 6), line(120, 64, 172, 64, { w: 5 })]),
    group([rect(84, 102, 110, 36, 12, { paint: 'soft' }), line(58, 120, 84, 120, { w: 4 }), circle(58, 120, 9), circle(102, 120, 6), line(120, 120, 160, 120, { w: 5 })]),
    group([rect(84, 158, 110, 36, 12, { paint: 'soft' }), line(58, 176, 84, 176, { w: 4 }), circle(58, 176, 9), circle(102, 176, 6), line(120, 176, 168, 176, { w: 5 })]),
  ] },
  owner: { width: 240, height: 240, parts: [
    group([
      circle(104, 76, 36, { tone: 'purple' }),
      path('M34 216 C34 158 66 128 104 128 C142 128 174 158 174 216 Z', { paint: 'soft', tone: 'purple', w: 4 }),
    ]),
    group([
      path('M178 122 L216 136 V170 C216 194 200 210 178 220 C156 210 140 194 140 170 V136 Z', { tone: 'success' }),
      path('M162 170 L174 183 L196 156', { paint: 'inkline', w: 7 }),
    ]),
  ] },
  outcome: { width: 240, height: 240, parts: [
    circle(112, 130, 92, { paint: 'line', w: 5 }),
    circle(112, 130, 62, { paint: 'soft', w: 4 }),
    circle(112, 130, 32, { paint: 'soft', w: 4 }),
    circle(112, 130, 12),
    group([
      line(214, 28, 122, 120, { tone: 'light', w: 7, draw: true }),
      path('M196 20 H222 V46', { paint: 'line', tone: 'light', w: 7 }),
    ]),
  ] },
  boundary: { width: 240, height: 240, parts: [
    line(116, 14, 116, 226, { dash: 'dashes', motion: 'flow', w: 4 }),
    group([path('M10 112 L36 140 L10 168', { paint: 'line', w: 8 }), path('M34 112 L60 140 L34 168', { paint: 'line', w: 8 })]),
    group([
      path('M94 106 V82 A22 22 0 0 1 138 82 V106', { paint: 'line', w: 8 }),
      rect(76, 104, 80, 76, 14),
      circle(116, 134, 9, { paint: 'ink' }), line(116, 138, 116, 158, { paint: 'inkline', w: 7 }),
    ]),
    group([
      circle(196, 98, 18, { tone: 'purple' }),
      path('M164 178 C164 148 178 128 196 128 C214 128 228 148 228 178 Z', { paint: 'soft', tone: 'purple', w: 4 }),
    ]),
  ] },
  layers: { width: 240, height: 240, parts: [slab(128, 'soft'), slab(72, 'soft'), slab(16, 'solid')] },
  process: { width: 364, height: 200, parts: [
    circle(36, 100, 22),
    line(62, 100, 84, 100, { dash: 'dashes', motion: 'flow', w: 5 }), path('M80 90 L90 100 L80 110', { paint: 'line', w: 5 }),
    group([
      rect(94, 56, 76, 88, 18, { paint: 'soft' }),
      line(112, 82, 152, 82, { w: 6 }), line(112, 100, 140, 100, { w: 6 }), line(112, 118, 148, 118, { w: 6 }),
    ]),
    line(174, 100, 196, 100, { dash: 'dashes', motion: 'flow', w: 5 }), path('M192 90 L202 100 L192 110', { paint: 'line', w: 5 }),
    group([
      rect(206, 56, 76, 88, 18, { paint: 'soft' }),
      line(224, 82, 264, 82, { w: 6 }), line(224, 100, 252, 100, { w: 6 }), line(224, 118, 260, 118, { w: 6 }),
    ]),
    line(286, 100, 298, 100, { dash: 'dashes', motion: 'flow', w: 5 }), path('M296 90 L306 100 L296 110', { paint: 'line', w: 5 }),
    path('M332 76 L356 100 L332 124 L308 100 Z', { tone: 'success' }),
  ] },
  plan: { width: 240, height: 240, parts: [
    rect(36, 38, 168, 188, 18, { paint: 'soft', w: 4 }),
    group([rect(88, 20, 64, 34, 12), rect(106, 31, 28, 8, 4, { paint: 'ink' })]),
    ...[[84, 84, true], [120, 70, true], [156, 90, false], [192, 60, false]].map(([y, length, done]) => group([
      rect(58, y - 12, 24, 24, 7, done ? {} : { paint: 'line', w: 4 }),
      ...(done ? [path(`M62 ${y} L68 ${y + 6} L78 ${y - 6}`, { paint: 'inkline', w: 4 })] : []),
      line(96, y, 96 + length, y, { w: 7, draw: true }),
    ])),
  ] },
};

function build(document, spec, parent) {
  const element = document.createElementNS(SVG_NS, spec.shape);
  const classes = spec.shape === 'g' ? ['visual-asset__group'] : ['visual-asset__part', `visual-asset__part--${spec.paint ?? 'solid'}`];
  if (spec.draw) { classes.push('visual-asset__part--draw'); element.setAttribute('pathLength', '1'); }
  element.setAttribute('class', classes.join(' '));
  if (spec.tone) element.setAttribute('data-tone', spec.tone);
  if (spec.dash) element.setAttribute('data-dash', spec.dash);
  if (spec.motion) element.setAttribute('data-motion', spec.motion);
  if (spec.origin) element.style.transformOrigin = `${spec.origin[0]}px ${spec.origin[1]}px`;
  if (spec.w) element.style.setProperty('--w', String(spec.w));
  for (const [name, value] of Object.entries(spec.attrs ?? {})) element.setAttribute(name, String(value));
  for (const child of spec.parts ?? []) build(document, child, element);
  parent.append(element);
}

/** Builds an asset as an inline SVG; every top-level part sits in an entry wrapper that carries the assemble-in stagger. */
export function buildVisualAsset(document, id) {
  const asset = Object.hasOwn(VISUAL_ASSETS, id) ? VISUAL_ASSETS[id] : undefined;
  if (!asset) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'visual-asset');
  svg.setAttribute('viewBox', `0 0 ${asset.width} ${asset.height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  asset.parts.forEach((spec, index) => {
    const entry = document.createElementNS(SVG_NS, 'g');
    entry.setAttribute('class', 'visual-asset__entry');
    entry.style.setProperty('--part-index', String(index));
    build(document, spec, entry);
    svg.append(entry);
  });
  return svg;
}
