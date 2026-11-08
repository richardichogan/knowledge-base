import type { VisualAsset, VisualIcon, VisualLink, VisualNode, VisualPattern, VisualPatternSubject, VisualPort, VisualTone } from '../types/visualComposition.js';

/**
 * Deterministic layout for script visuals. The designer chooses a pattern and its subjects; this module owns every
 * coordinate, so peers share exact centre lines, gaps are equal and the focal subject is always the largest.
 * Pure and browser-safe: the backend parser, Athena edits and the web preview all expand patterns identically.
 */
export const VISUAL_PATTERN_TYPES = ['flow', 'converge', 'branch', 'stack', 'compare', 'hub', 'cycle', 'statement', 'tree', 'tiers'] as const;
export const VISUAL_PATTERN_KINDS = ['icon', 'panel', 'text', 'block'] as const;
export const VISUAL_PATTERN_GUIDE = {
  flow: '2–5 subjects in one row, left to right, on a single centre line with equal gaps. A process, handoff or progression. Focus (optional) is normally the last subject.',
  converge: '2–4 sources stacked in a column on the left, equally spaced, all feeding the focus on the right. Several contributions combining into one outcome. Focus required.',
  branch: 'The focus on the left fanning out to 2–4 destinations stacked in an equally spaced column on the right. A coordinator, router or one input with several outputs. Focus required.',
  stack: '2–4 subjects in one centred column, top to bottom. Layers, a hierarchy or a dependency resting on a foundation. Focus (optional) is normally the base.',
  compare: 'Exactly 2 subjects, mirrored left and right at equal size. Before/after, old/new, two options. No focus.',
  hub: 'The focus in the centre with 2–6 subjects in two equally spaced columns either side of it. A central idea and its connected parts. Focus required.',
  cycle: '3–6 stages evenly spaced clockwise around an ellipse from the top, optionally around a focus hub. A lifecycle or loop. Links between consecutive stages become one continuous orbiting ring.',
  statement: 'One dominant statement (the focus) with 0–3 supporting subjects in a row beneath it. A takeaway or single big idea. Focus required.',
  tree: 'The focus as the root centred above 2–4 children in an equally spaced row beneath — an org chart. Ownership, accountability or one thing decomposing into parts. Focus required; connect root to each child with style "line" (ports are set by the engine).',
  tiers: 'A pyramid of 2–4 filled blocks listed base first, each tier narrower than the one beneath it. A foundation building to a peak, maturity levels or diminishing scale. Kind is always "block"; no focus, no connections.',
} as const satisfies Record<typeof VISUAL_PATTERN_TYPES[number], string>;

const AREA = { left: 80, right: 1520, top: 240, bottom: 800 };
const INNER = { left: 112, right: 1488, top: 256, bottom: 784 };
const MID_X = (INNER.left + INNER.right) / 2;
const MID_Y = (INNER.top + INNER.bottom) / 2;
const COUNTS: Record<VisualPattern['type'], [number, number]> = {
  flow: [2, 5], converge: [3, 5], branch: [3, 5], stack: [2, 4], compare: [2, 2], hub: [3, 7], cycle: [3, 7], statement: [1, 4], tree: [3, 5], tiers: [2, 4],
};
const ASPECT: Partial<Record<VisualAsset, number>> = { 'workforce-pair': 1.5, process: 1.82 };
const TONES = ['teal', 'blue', 'purple', 'neutral', 'warning', 'success'];
/** Tried in order until the pattern fits: full size, tighter gaps, then peers stepped down to the secondary role. */
const DENSITIES = [{ peer: 1, gap: 1 }, { peer: 1, gap: 0.7 }, { peer: 0.8, gap: 0.7 }, { peer: 0.8, gap: 0.5 }];

interface Box { subject: VisualPatternSubject; focus: boolean; role: 'hero' | 'primary' | 'secondary'; kind: VisualNode['kind']; size?: VisualNode['size'];
  width: number; height: number; anchor: number; x: number; y: number }

function fail(message: string): never { throw new Error(`Invalid visual pattern: ${message}`); }

/** Rendered height of wrapped text, mirroring visuals.css (IBM Plex Sans averages ~0.53em per character). */
function block(value: string, font: number, lineHeight: number, width: number): number {
  if (!value) return 0;
  const lines = value.split(/\s+/).reduce((state, word) => {
    const run = state.run ? state.run + 1 + word.length : word.length;
    return run * font * 0.53 > width && state.run ? { lines: state.lines + 1, run: word.length } : { lines: state.lines, run };
  }, { lines: 1, run: 0 }).lines;
  return Math.ceil(lines * font * lineHeight);
}

/** Natural single-line width of text, capped where the CSS would wrap it. */
function natural(value: string, font: number, cap: number): number {
  return Math.min(cap, Math.ceil(value.length * font * 0.53));
}

/** Box sizes follow visuals.css: role scale 1.45 for the focus, 1 for peers, 0.8 for peers stepped down to fit. */
function measure(subject: VisualPatternSubject, focus: boolean, kind: typeof VISUAL_PATTERN_KINDS[number], textSize: VisualNode['size'],
  peerScale: number, panelWidth: number): Box {
  const r = focus ? 1.45 : peerScale;
  const role: Box['role'] = focus ? 'hero' : peerScale < 1 ? 'secondary' : 'primary';
  const base = { subject, focus, role, x: 0, y: 0 };
  const kicker = subject.kicker ? 17 : 0;
  if (subject.asset || kind === 'icon') {
    const asset = subject.asset;
    const cap = focus ? 320 : 240 * peerScale;
    const words = Math.max(natural(subject.label, 30 * r, cap), natural(subject.detail, 20 * r, cap), natural(subject.kicker ?? '', 14 * 1.2, cap));
    const width = asset ? Math.max((focus ? 300 : 200 * peerScale) * (ASPECT[asset] ?? 1), words)
      : Math.max(words, 112 * r + 48);
    const gap = asset ? 16 : 20;
    const caption = [kicker, block(subject.label, 30 * r, 1.2, width), block(subject.detail, 20 * r, 1.35, width)].filter(Boolean);
    const graphic = asset ? (focus ? 300 : 200 * peerScale) : 112 * r;
    const height = graphic + caption.reduce((sum, part) => sum + part, 0) + gap * caption.length;
    return { ...base, kind: asset ? 'asset' : 'icon', width, height, anchor: graphic / 2 };
  }
  if (kind === 'panel' || kind === 'block') {
    const width = (focus ? Math.max(400, panelWidth) : panelWidth * peerScale);
    const padX = kind === 'block' ? 72 : 56;
    const padY = kind === 'block' ? 56 : 48;
    const labelFont = (kind === 'block' ? 40 : 32) * r;
    const detailFont = (kind === 'block' ? 20 : 22) * r;
    const gap = kind === 'block' ? 8 : 12;
    const inner = Math.max(120, width - padX);
    const parts = [kind === 'panel' && subject.icon ? 40 * r : 0, kicker, block(subject.label, labelFont, 1.2, inner), block(subject.detail, detailFont, 1.35, inner)].filter(Boolean);
    const height = padY + parts.reduce((sum, part) => sum + part, 0) + gap * (parts.length - 1);
    return { ...base, kind, width, height, anchor: height / 2 };
  }
  const size = textSize ?? 'm';
  const font = ({ xl: 96, l: 64, m: 44, s: 30 } as const)[size], leading = ({ xl: 1.02, l: 1.08, m: 1.12, s: 1.25 } as const)[size];
  const cap = ({ xl: 1200, l: 640, m: 360, s: 300 } as const)[size];
  const width = Math.max(120, natural(subject.label, font, cap), natural(subject.detail, 22, Math.min(cap, 466)), natural(subject.kicker ?? '', 14 * 1.2, cap)) + 8;
  const parts = [kicker, block(subject.label, font, leading, width), block(subject.detail, 22, 1.35, Math.min(width, 466))].filter(Boolean);
  const height = parts.reduce((sum, part) => sum + part, 0) + 12 * (parts.length - 1);
  return { ...base, kind: 'text', size, width, height, anchor: height / 2 };
}

/** Where the connector attaches once a box is resized: icons and drawn assets keep their top graphic; other content re-centres. */
function resize(box: Box, height: number): void {
  if (box.kind !== 'icon' && box.kind !== 'asset') box.anchor = height / 2;
  box.height = height;
}

/** Peers share one size; the focal subject is always strictly larger than every peer. */
function equalise(boxes: Box[]): void {
  const peers = boxes.filter(box => !box.focus);
  for (const group of [peers.filter(box => box.kind === 'asset'), peers.filter(box => box.kind !== 'asset')]) {
    if (!group.length) continue;
    const height = Math.max(...group.map(box => box.height));
    const square = group.filter(box => box.kind !== 'asset' || !ASPECT[box.subject.asset!]);
    const width = Math.max(0, ...square.map(box => box.width));
    for (const box of group) {
      resize(box, height);
      if (square.includes(box)) box.width = width;
    }
  }
  const focus = boxes.find(box => box.focus);
  if (!focus || !peers.length) return;
  const peerWidth = Math.max(...peers.map(box => box.width)), peerHeight = Math.max(...peers.map(box => box.height));
  if (focus.width < peerWidth * 1.15) focus.width = peerWidth * 1.15;
  if (focus.height < peerHeight * 1.1) resize(focus, peerHeight * 1.1);
}

/** Room a connection label needs along its run, doubled at a fan junction where the label sits beyond the split. */
function labelRun(label: string, vertical: boolean, fan: boolean): number {
  if (!label) return 0;
  return (label.length * 14 + (vertical ? 80 : 48)) * (fan ? 2 : 1);
}

/** The anchor line that centres a group's full extent (captions included) on `middle`. */
function centredLine(boxes: Box[], middle: number): number {
  const above = Math.max(...boxes.map(box => box.anchor)), below = Math.max(...boxes.map(box => box.height - box.anchor));
  return middle - (above + below) / 2 + above;
}

function placeRow(boxes: Box[], line: number, minGap: number, left = INNER.left, right = INNER.right): void {
  const total = boxes.reduce((sum, box) => sum + box.width, 0);
  const gap = Math.max(minGap, Math.min((right - left - total) / Math.max(1, boxes.length - 1), 240));
  let x = (left + right) / 2 - (total + gap * (boxes.length - 1)) / 2;
  for (const box of boxes) { box.x = x; box.y = line - box.anchor; x += box.width + gap; }
}

/** Stacks boxes with equal edge-to-edge vertical gaps, centring the group's full extent on `middle`. */
function placeColumn(boxes: Box[], centreX: number, middle: number, minGap: number): void {
  const total = boxes.reduce((sum, box) => sum + box.height, 0) + minGap * Math.max(0, boxes.length - 1);
  let y = middle - total / 2;
  for (const box of boxes) {
    box.x = centreX - box.width / 2;
    box.y = y;
    y += box.height + minGap;
  }
}

/** Even angular spacing; a ring around a focus starts half a step round so no subject sits directly above the centre. */
function placeRing(boxes: Box[], centreX: number, centreY: number, rx: number, ry: number, offset: boolean): void {
  const step = 2 * Math.PI / boxes.length;
  const start = boxes.length === 2 ? Math.PI : -Math.PI / 2 + (offset ? step / 2 : 0);
  boxes.forEach((box, index) => {
    const angle = start + index * step;
    box.x = centreX + Math.cos(angle) * rx - box.width / 2;
    box.y = centreY + Math.sin(angle) * ry - box.anchor;
  });
}

/** Splits peers into two columns flanking a central focus — the hub arrangement, also used when a
 *  converge or branch has too many subjects for a single column of full content. */
function placeFlanked(lead: Box, others: Box[], gap: number, columnGap: number): void {
  const left = others.slice(0, Math.ceil(others.length / 2)), right = others.slice(Math.ceil(others.length / 2));
  const column = Math.max(...others.map(box => box.width));
  lead.x = MID_X - lead.width / 2;
  placeColumn(left, lead.x - gap - column / 2, MID_Y, columnGap);
  if (right.length) placeColumn(right, lead.x + lead.width + gap + column / 2, MID_Y, columnGap);
  const first = left[0]!, last = left[left.length - 1]!;
  lead.y = (first.y + first.anchor + last.y + last.anchor) / 2 - lead.anchor;
  if (right.length !== left.length) for (const box of right) box.y += lead.y + lead.anchor - (right[0]!.y + right[0]!.anchor + right[right.length - 1]!.y + right[right.length - 1]!.anchor) / 2;
}

function layout(pattern: VisualPattern, links: VisualLink[], density: typeof DENSITIES[number], small = false): Box[] {
  const focusId = pattern.focus;
  const textSize = (subject: VisualPatternSubject): VisualNode['size'] => pattern.type === 'statement'
    ? subject.id === focusId ? (small ? 'l' : 'xl') : 's'
    : subject.id === focusId ? (small ? 'm' : 'l') : small ? 's' : 'm';
  const panelWidth = pattern.type === 'stack' ? 720 : pattern.type === 'compare' ? 440 : pattern.type === 'converge' || pattern.type === 'branch' ? 420 : 320;
  const boxes = pattern.subjects.map(subject => measure(subject, subject.id === focusId, pattern.kind, textSize(subject), density.peer, panelWidth));
  if (pattern.type !== 'statement' && pattern.type !== 'tiers') equalise(boxes);
  const focus = boxes.find(box => box.focus);
  const others = boxes.filter(box => !box.focus);
  const longest = (vertical: boolean, fan: boolean) => Math.max(0, ...links.map(link => labelRun(link.label, vertical, fan)));
  switch (pattern.type) {
    case 'flow':
      placeRow(boxes, centredLine(boxes, MID_Y), Math.max(96 * density.gap, longest(false, false)));
      break;
    case 'stack':
      placeColumn(boxes, MID_X, MID_Y, Math.max((links.length ? 64 : 36) * density.gap, longest(true, false)));
      break;
    case 'compare':
      placeRow(boxes, centredLine(boxes, MID_Y), 240 * density.gap, INNER.left + 80, INNER.right - 80);
      break;
    case 'converge':
    case 'branch': {
      if (others.length >= 4) {
        // A single column of four-plus full subjects cannot fit the frame's height; flank the focus
        // hub-style instead — sources (or branches) on both sides still read as many-to-one.
        placeFlanked(focus!, others, Math.max(160 * density.gap, longest(false, true)), 48 * density.gap);
        break;
      }
      const gap = Math.max(200 * density.gap, longest(false, true));
      const column = Math.max(...others.map(box => box.width));
      const span = column + gap + focus!.width;
      const leftEdge = MID_X - span / 2;
      const columnX = pattern.type === 'converge' ? leftEdge + column / 2 : leftEdge + focus!.width + gap + column / 2;
      placeColumn(others, columnX, MID_Y, 48 * density.gap);
      const first = others[0]!, last = others[others.length - 1]!;
      focus!.x = pattern.type === 'converge' ? leftEdge + column + gap : leftEdge;
      focus!.y = (first.y + first.anchor + last.y + last.anchor) / 2 - focus!.anchor;
      break;
    }
    case 'hub': {
      placeFlanked(focus!, others, Math.max(160 * density.gap, longest(false, true)), 48 * density.gap);
      break;
    }
    case 'cycle': {
      const maxWidth = Math.max(...others.map(box => box.width)), height = Math.max(...others.map(box => box.height));
      const anchor = Math.max(...others.map(box => box.anchor));
      const offset = others.length === 4 && !!focus;
      const rx = Math.min(560, (INNER.right - INNER.left - maxWidth) / 2);
      const stageReachY = Math.max(0, (INNER.bottom - INNER.top - height) / 2);
      const ry = offset ? Math.min(228, stageReachY * Math.SQRT2) : stageReachY;
      const cy = offset ? MID_Y : INNER.top + anchor + ry;
      placeRing(others, MID_X, cy, rx, ry, !!focus);
      if (focus) { focus.x = MID_X - focus.width / 2; focus.y = cy - focus.height / 2; }
      break;
    }
    case 'statement': {
      const lead = focus!;
      if (!others.length) { lead.x = MID_X - lead.width / 2; lead.y = MID_Y - lead.height / 2; break; }
      const rowHeight = Math.max(...others.map(box => box.height));
      const top = MID_Y - (lead.height + 72 + rowHeight) / 2;
      lead.x = MID_X - lead.width / 2; lead.y = top;
      placeRow(others, top + lead.height + 72 + Math.max(...others.map(box => box.anchor)), 96, INNER.left + 120, INNER.right - 120);
      break;
    }
    case 'tree': {
      const lead = focus!;
      const gap = Math.max(120 * density.gap, longest(true, false));
      const rowHeight = Math.max(...others.map(box => box.height));
      const top = MID_Y - (lead.height + gap + rowHeight) / 2;
      lead.x = MID_X - lead.width / 2; lead.y = top;
      placeRow(others, top + lead.height + gap + Math.max(...others.map(box => box.anchor)), 48 * density.gap);
      break;
    }
    case 'tiers': {
      // The box IS the data: widths step down evenly from a full-width base, so size carries the meaning.
      const gap = 24, n = boxes.length;
      const avail = AREA.bottom - AREA.top;
      boxes.forEach((box, index) => {
        const width = (AREA.right - AREA.left) * (n + 1 - index) / (n + 1);
        const remeasured = measure(box.subject, false, 'block', undefined, density.peer, width / density.peer);
        box.width = width;
        box.height = remeasured.height;
      });
      const height = Math.max(Math.max(...boxes.map(box => box.height)), Math.min(160, (avail - gap * (n - 1)) / n));
      const base = MID_Y + (n * height + gap * (n - 1)) / 2;
      boxes.forEach((box, index) => {
        resize(box, height);
        box.x = MID_X - box.width / 2;
        box.y = base - (index + 1) * height - index * gap;
      });
      break;
    }
  }
  return boxes;
}

/** Every pair of boxes keeps the 24px separation that stops captions and discs colliding. */
function separated(boxes: Box[]): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      const apart = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), a.y - (b.y + b.height), b.y - (a.y + a.height));
      if (apart < 24) return false;
    }
  }
  return true;
}

function fits(boxes: Box[]): boolean {
  for (const box of boxes) {
    if (box.x < AREA.left || box.y < AREA.top || box.x + box.width > AREA.right || box.y + box.height > AREA.bottom) return false;
  }
  return separated(boxes);
}

/** How far the arrangement overruns the content area on its worst axis (1 = fits exactly). */
function overflowRatio(boxes: Box[]): number {
  const width = Math.max(...boxes.map(box => box.x + box.width)) - Math.min(...boxes.map(box => box.x));
  const height = Math.max(...boxes.map(box => box.y + box.height)) - Math.min(...boxes.map(box => box.y));
  return Math.max(width / (AREA.right - AREA.left), height / (AREA.bottom - AREA.top), 1);
}

/** The renderer scales a whole composition down to fit the slide, so an arrangement may overrun the content
 * area by this linear ratio before any content is sacrificed (a 1.5 overrun renders at ~0.67 scale, which
 * keeps even the smallest caption text legible). */
const MAX_OVERFLOW = 1.5;

function ports(type: VisualPattern['type'], from: Box, to: Box): { fromPort?: VisualPort; toPort?: VisualPort } {
  const dx = (to.x + to.width / 2) - (from.x + from.width / 2);
  const dy = (to.y + to.anchor) - (from.y + from.anchor);
  if (type === 'flow' || type === 'converge' || type === 'branch' || type === 'compare' || type === 'hub') {
    if (Math.abs(dx) < 1) return {};
    return dx > 0 ? { fromPort: 'right', toPort: 'left' } : { fromPort: 'left', toPort: 'right' };
  }
  if (type === 'stack' && Math.abs(dy) > 1) return dy > 0 ? { fromPort: 'bottom', toPort: 'top' } : { fromPort: 'top', toPort: 'bottom' };
  if (type === 'tree' && Math.abs(dy) > 1) return dy > 0 ? { fromPort: 'bottom', toPort: 'top' } : { fromPort: 'top', toPort: 'bottom' };
  return {};
}

export function parseVisualPattern(value: unknown, reveal: (value: unknown) => number, text: (value: unknown, limit: number, label: string, empty?: boolean) => string,
  icons: readonly string[], assets: readonly string[]): VisualPattern {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('pattern must be an object.');
  const data = value as Record<string, unknown>;
  if (!(VISUAL_PATTERN_TYPES as readonly string[]).includes(String(data.type))) fail(`type must be one of ${VISUAL_PATTERN_TYPES.join(', ')}.`);
  const type = data.type as VisualPattern['type'];
  const kind = data.kind ?? (type === 'tiers' ? 'block' : 'icon');
  if (!(VISUAL_PATTERN_KINDS as readonly string[]).includes(String(kind))) fail(`kind must be one of ${VISUAL_PATTERN_KINDS.join(', ')} (drawn graphics are chosen per subject with "asset").`);
  if ((kind === 'block') !== (type === 'tiers')) fail('kind "block" belongs to the tiers pattern only — a tiers always draws blocks, so omit its kind or set "block".');
  if (!Array.isArray(data.subjects)) fail('subjects must be an array.');
  const [min, max] = COUNTS[type];
  if (data.subjects.length < min || data.subjects.length > max) fail(`a ${type} needs ${min}–${max} subjects including any focus.`);
  const ids = new Set<string>();
  const subjects = data.subjects.map((raw): VisualPatternSubject => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('each subject must be an object.');
    const subject = raw as Record<string, unknown>;
    const id = text(subject.id, 80, 'pattern subject id');
    if (ids.has(id)) fail(`subject ids must be unique ("${id}").`);
    ids.add(id);
    if (!TONES.includes(String(subject.tone))) fail(`subject "${id}" needs a tone.`);
    const icon = String(subject.icon ?? '');
    if (!icons.includes(icon)) fail(`subject "${id}" has unknown icon "${icon}".`);
    if (subject.asset !== undefined && subject.asset !== '' && !assets.includes(String(subject.asset))) fail(`subject "${id}" has unknown asset "${String(subject.asset)}".`);
    if (subject.emphasis !== undefined && !['highlight', 'underline', 'strike'].includes(String(subject.emphasis))) fail(`subject "${id}" has invalid emphasis.`);
    const asset = subject.asset ? subject.asset as VisualAsset : undefined;
    if (asset && kind === 'block') fail(`subject "${id}": blocks are filled colour fields and draw no graphics, so they cannot take an asset.`);
    if (!asset && kind === 'icon' && !icon) fail(`subject "${id}" needs an icon (or an asset) in an icon pattern.`);
    return { id, label: text(subject.label, 120, 'pattern subject label', true), detail: text(subject.detail ?? '', 240, 'pattern subject detail', true),
      tone: subject.tone as VisualTone, reveal: reveal(subject.reveal),
      ...(asset ? { asset } : {}), ...(icon ? { icon: icon as VisualIcon } : {}),
      ...(subject.kicker ? { kicker: text(subject.kicker, 40, 'pattern subject kicker') } : {}),
      ...(subject.emphasis ? { emphasis: subject.emphasis as NonNullable<VisualPatternSubject['emphasis']> } : {}) };
  });
  const focus = data.focus === undefined || data.focus === '' ? '' : String(data.focus);
  if (focus && !ids.has(focus)) fail(`focus "${focus}" is not one of the subjects.`);
  const needsFocus = ['converge', 'branch', 'hub', 'statement', 'tree'].includes(type);
  if (needsFocus && !focus) fail(`a ${type} needs a focus subject.`);
  if (type === 'compare' && focus) fail('a compare has no focus.');
  if (type === 'tiers' && focus) fail('a tiers has no focus — order the subjects base first.');
  if (type === 'flow' && subjects.length < 2) fail('a flow needs at least 2 subjects.');
  if (type === 'cycle' && subjects.filter(subject => subject.id !== focus).length < 3) fail('a cycle needs at least 3 stages.');
  return { type, kind: kind as VisualPattern['kind'], ...(focus ? { focus } : {}), subjects };
}

/** Slides the whole arrangement back inside the content area when its extent allows, preserving every relative position. */
function nudge(boxes: Box[]): void {
  const top = Math.min(...boxes.map(box => box.y)), bottom = Math.max(...boxes.map(box => box.y + box.height));
  const left = Math.min(...boxes.map(box => box.x)), right = Math.max(...boxes.map(box => box.x + box.width));
  if (bottom - top <= AREA.bottom - AREA.top) {
    const dy = Math.max(0, AREA.top - top) || Math.min(0, AREA.bottom - bottom);
    if (dy) for (const box of boxes) box.y += dy;
  }
  if (right - left <= AREA.right - AREA.left) {
    const dx = Math.max(0, AREA.left - left) || Math.min(0, AREA.right - right);
    if (dx) for (const box of boxes) box.x += dx;
  }
}

/** Expands a pattern into renderer nodes, and settles link ports/routes to match the geometry. */
export function layoutVisualPattern(pattern: VisualPattern, links: VisualLink[]): { nodes: VisualNode[]; links: VisualLink[] } {
  // Content is sacred: an arrangement that overruns the area is accepted whole (up to MAX_OVERFLOW) and the
  // renderer scales it down to fit, keeping every icon, detail and label. Degradation stages — dropping
  // connection labels, then details, then panel icons, then demoting to text — only apply beyond that bound.
  const stages: { pattern: VisualPattern; links: VisualLink[]; small?: boolean }[] = [{ pattern, links }];
  if (pattern.type === 'tiers' && links.length) fail('a tiers has no connections — the stacking itself carries the relationship.');
  const unlabelled = links.map(link => ({ ...link, label: '' }));
  const labelled = links.some(link => link.label);
  const strip = (base: VisualPattern, icons: boolean): VisualPattern =>
    ({ ...base, subjects: base.subjects.map(subject => {
      const { icon, ...rest } = subject;
      return { ...rest, detail: '', ...(icons || icon === undefined ? {} : { icon }) };
    }) });
  if (labelled) stages.push({ pattern, links: unlabelled });
  // A column of disc-and-caption icons is tall; panels carry the same icon, label, detail and kicker in a
  // denser card. Re-kind before any content is stripped — form degrades before meaning does.
  if (pattern.kind === 'icon') {
    const panelled: VisualPattern = { ...pattern, kind: 'panel' };
    stages.push({ pattern: panelled, links });
    if (labelled) stages.push({ pattern: panelled, links: unlabelled });
  }
  if (pattern.subjects.some(subject => subject.detail)) {
    const lean = strip(pattern, false);
    stages.push({ pattern: lean, links });
    if (labelled) stages.push({ pattern: lean, links: unlabelled });
  }
  if (pattern.kind === 'panel' && pattern.subjects.some(subject => subject.icon)) {
    stages.push({ pattern: strip(pattern, true), links: labelled ? unlabelled : links });
  }
  let boxes: Box[] = [];
  let settledLinks = links;
  let fitted = false;
  let best: { boxes: Box[]; links: VisualLink[]; ratio: number } | null = null;
  for (const stage of stages) {
    for (const density of DENSITIES) {
      const candidate = layout(stage.pattern, stage.links, density, stage.small ?? false);
      if (!fits(candidate)) nudge(candidate);
      if (fits(candidate)) { boxes = candidate; settledLinks = stage.links; fitted = true; break; }
      if (!separated(candidate)) continue;
      const ratio = overflowRatio(candidate);
      if (!best || ratio < best.ratio) best = { boxes: candidate, links: stage.links, ratio };
    }
    if (fitted) break;
    // Prefer the complete arrangement rendered smaller over a stripped one rendered at full size.
    if (best && best.ratio <= MAX_OVERFLOW) break;
  }
  if (!fitted && best) { boxes = best.boxes; settledLinks = best.links; fitted = true; }
  if (!fitted) {
    fail(`the ${pattern.type} is too crowded for the required 24px separation between subjects even with peers stepped down. Use fewer subjects, or shorten labels and connection labels.`);
  }
  const byId = new Map(boxes.map(box => [box.subject.id, box]));
  const ring = pattern.type === 'cycle' ? boxes.filter(box => !box.focus).map(box => box.subject.id) : [];
  const nodes = boxes.map((box): VisualNode => {
    const { subject } = box;
    return { id: subject.id, kind: box.kind, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
      label: subject.label, detail: subject.detail, tone: subject.tone, reveal: subject.reveal,
      icon: box.kind === 'icon' || box.kind === 'panel' ? subject.icon ?? '' : '',
      ...(box.kind === 'asset' ? { asset: subject.asset! } : {}),
      ...(box.kind !== 'text' ? { role: box.role } : {}),
      ...(box.kind === 'text' && box.size ? { size: box.size } : {}),
      ...(subject.kicker ? { kicker: subject.kicker } : {}),
      ...(subject.emphasis ? { emphasis: subject.emphasis } : {}) };
  });
  const settled = settledLinks.map((link): VisualLink => {
    const from = byId.get(link.from), to = byId.get(link.to);
    if (!from || !to) return link;
    const { fromPort: _f, toPort: _t, route: _r, ...rest } = link;
    const index = ring.indexOf(link.from);
    if (index >= 0 && ring[(index + 1) % ring.length] === link.to) return { ...rest, route: 'arc' };
    return { ...rest, ...ports(pattern.type, from, to) };
  });
  return { nodes, links: settled };
}
