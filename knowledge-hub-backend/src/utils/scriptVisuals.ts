export const VISUAL_TEMPLATES = ['title', 'statistic', 'comparison', 'steps', 'concept', 'image', 'close'] as const;
export const SCRIPT_VISUAL_SOURCE_BUDGET = 60_000;
export const SCRIPT_VISUAL_INSTRUCTION_LIMIT = 4000;
const LIMITS = {
  subjects: 24, id: 100, nodeId: 80, nodeLabel: 120, nodeDetail: 240, kicker: 40,
  sceneLabel: 100, imagePrompt: 1800, shapes: 32, description: 500,
  path: 2400, scenes: 12, source: 500_000, quote: 300, items: 6,
  comparisonSides: 2, uniqueQuoteParts: 2, imageUrl: 2000, title: 160,
  subtitle: 500, itemDetail: 400, cueStride: 1_000_000, closeMarks: 2,
};
const CONTENT_AREA = { left: 80, right: 1520, top: 240, bottom: 800, lastTop: 790,
  minSize: 40, maxWidth: 1440, maxHeight: 550 };
const ART_AREA = { minX: -1600, maxX: 3200, minY: -900, maxY: 1800, maxRadius: 1600, minOpacity: 0.05 };
export const VISUAL_ASSET_IDS = ['foundation', 'workforce-pair', 'copilot', 'agent', 'automation', 'system', 'owner',
  'outcome', 'boundary', 'layers', 'process', 'plan'] as const;
export const VISUAL_ICON_IDS = ['', 'person', 'worker', 'document', 'check', 'system', 'arrow', 'boundary', 'clock', 'quality', 'coin', 'gauge'] as const;
const NODE_KINDS = ['panel', 'text', 'icon', 'image', 'asset'];
const NODE_STATES = { perNode: 4, minScale: 0.5, maxScale: 1.4 };
/** The presenter video (x1088–1520, y557–800) plus a 24px margin: framed graphics must stay clear of it. */
export const PRESENTER_VIDEO_AREA = { left: 1064, top: 533, right: 1520, bottom: 800 };
const ASSET_GUIDE: Record<typeof VISUAL_ASSET_IDS[number], string> = {
  foundation: 'square, teal: a classical pediment on columns and a base; an operating model, platform or governance foundation',
  'workforce-pair': '3:2, teal base: a person (purple) and a digital worker (blue) standing together; people and digital workers managed as one workforce',
  copilot: 'square, blue: a speech-bubble assistant with a sparkle; AI that advises a person',
  agent: 'square, teal: a hexagon with an orbiting ring and three connected nodes; a specialist agent with a defined role',
  automation: 'square, neutral: two meshing gears; fixed, repeatable automation',
  system: 'square, teal: a framed stack of three connected rows; a system or connected systems',
  owner: 'square, purple: a person holding a green accountability shield; the accountable human owner',
  outcome: 'square, success green: a target struck by an arrow; the business outcome',
  boundary: 'square, warning amber: a dashed line with a padlock beside a person; where authority and approval sit',
  layers: 'square, blue: three stacked isometric slabs, the top one solid; implementation layers or a stack',
  process: '91:50 wide, blue: a request flowing through two documents to a result; one process from start to finish',
  plan: 'square, teal: a clipboard with checkbox rows; a plan, controls or success measures',
};
/** Read by Athena and the visual designer so edits use exactly the vocabulary the renderer and both parsers accept. */
export const VISUAL_GRAMMAR = {
  nodeKinds: ['panel', 'text', 'icon', 'image', 'asset'],
  asset: 'kind "asset" draws a trusted vector graphic named by `asset` above its label/detail caption. The drawing fills the box above the caption, centred and true to its proportions, so give the box the graphic\'s proportions plus about 72px for a one-line caption (96px for a hero) and make a hero graphic\'s box the largest on the scene. Assets draw themselves in with their cue and idle gently while presenting; leave `icon` empty on them.',
  assets: ASSET_GUIDE,
  icons: VISUAL_ICON_IDS.filter(Boolean),
  role: 'Optional on panel, icon and asset nodes: hero (captions and icon symbols 1.45× with a glow on drawn graphics; use once per scene), primary (default), secondary (0.8×). A role never resizes the box, so make the hero\'s box the largest on the scene.',
  states: `Optional build steps per node (up to ${NODE_STATES.perNode}): {at, x?, y?, scale?, opacity?, focus?}. "at" is a whole reveal number after the node's own reveal, ascending. x/y give the box's new top-left corner, scale ${NODE_STATES.minScale}–${NODE_STATES.maxScale} grows or shrinks it about its centre, opacity 0–1, focus true adds a highlight ring or glow. Later states keep earlier x/y/scale. Connected nodes may only change focus.`,
  frame: 'composition.frame "around-presenter" (only with presenterLayout true) keeps the scene at full size around the presenter video instead of shrinking it; every node box, including each state, must then avoid the presenter area.',
  presenterArea: PRESENTER_VIDEO_AREA,
  contentArea: { left: CONTENT_AREA.left, right: CONTENT_AREA.right, top: CONTENT_AREA.top, bottom: CONTENT_AREA.bottom },
  pattern: 'composition.pattern {type, kind, focus, subjects:[{id,label,detail,tone,reveal,icon?,asset?,kicker?,emphasis?}]} lets the layout engine place every subject; nodes are then generated from it, so edit the pattern (or remove it to hand-place nodes). composition.links still name subject ids; ports and lifecycle arcs are set by the engine.',
  patternTypes: VISUAL_PATTERN_GUIDE,
  patternKinds: VISUAL_PATTERN_KINDS,
};
export type VisualTemplate = typeof VISUAL_TEMPLATES[number];
export interface VisualCue { blockId: string; quote: string }
export interface VisualArtwork {
  description: string;
  shapes: Array<{
    kind: 'circle' | 'rect' | 'path';
    x: number; y: number; width: number; height: number; radius: number;
    d: string; tone: 'teal' | 'blue' | 'purple' | 'neutral'; opacity: number;
  }>;
}
export interface ScriptVisualScene {
  id: string;
  template: VisualTemplate;
  title: string;
  subtitle: string;
  cue: VisualCue;
  items: Array<{ label: string; detail: string; cue: VisualCue }>;
  imageUrl: string;
  imageAlt: string;
  artwork?: VisualArtwork;
  layout?: 'hero' | 'split' | 'diagram';
  composition?: VisualComposition;
  presenterLayout?: boolean;
  brandMark?: 'ibm-8bar';
}
export interface ScriptVisuals { version: 1; source: string; scenes: ScriptVisualScene[] }
export interface VisualScriptBlock {
  id?: string; type?: string; props?: Record<string, unknown>; content?: unknown; children?: VisualScriptBlock[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid visual data.');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, label: string, empty = false): string {
  if (typeof value !== 'string') throw new Error(`Invalid visual ${label}: it must be a string.`);
  if (value.length > limit) throw new Error(`Invalid visual ${label}: ${value.length} characters is over the ${limit}-character limit. Shorten it.`);
  if (!empty && !value.trim()) throw new Error(`Invalid visual ${label}: it must not be empty.`);
  return value;
}
export function parseVisualComposition(value: unknown, reveals: number, titleOnly = false, presenter = false): VisualComposition {
  let data = object(value);
  let pattern: VisualPattern | undefined;
  if (data.pattern !== undefined) {
    if (data.imageTreatment !== undefined || data.frame !== undefined) throw new Error('A pattern composition cannot also set imageTreatment or frame.');
    if (!Array.isArray(data.links)) throw new Error('A pattern composition needs a links array (it may be empty).');
    const step = (raw: unknown): number => {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > reveals) throw new Error(`Invalid visual pattern: subject reveals must be whole numbers 0–${reveals}.`);
      return raw;
    };
    pattern = parseVisualPattern(data.pattern, step, text, VISUAL_ICON_IDS, VISUAL_ASSET_IDS);
    const rawLinks = data.links.map(raw => ({ ...object(raw), label: typeof object(raw).label === 'string' ? object(raw).label : '' })) as unknown as VisualLink[];
    const generated = layoutVisualPattern(pattern, rawLinks);
    data = { ...data, nodes: generated.nodes, links: generated.links };
  }
  if (data.imageTreatment !== undefined && data.imageTreatment !== 'full' && data.imageTreatment !== 'blend') throw new Error('Invalid header image treatment.');
  if (data.frame !== undefined && data.frame !== 'around-presenter') throw new Error('Invalid composition frame. Use "around-presenter" or omit it.');
  if (!Array.isArray(data.nodes) || (!data.nodes.length && !data.imageTreatment && !titleOnly) || data.nodes.length > LIMITS.subjects
    || !Array.isArray(data.links) || data.links.length > LIMITS.subjects) throw new Error('A composition needs 1–24 nodes and at most 24 connections.');
  if (data.imageTreatment && (data.nodes.length || data.links.length || reveals)) throw new Error('A header image cannot be mixed with diagram nodes, connections or animated builds.');
  if (!data.nodes.length && (data.links.length || reveals)) throw new Error('A title-only composition cannot contain connections or builds.');
  const number = (value: unknown, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid composition geometry or reveal.');
    return value;
  };
  const reveal = (value: unknown): number => {
    const result = number(value, 0, reveals);
    if (!Number.isInteger(result)) throw new Error('Composition reveals must reference a whole item number.');
    return result;
  };
  const tone = (value: unknown): VisualNode['tone'] => {
    if (!['teal', 'blue', 'purple', 'neutral', 'warning', 'success'].includes(String(value))) throw new Error('Invalid composition tone.');
    return value as VisualNode['tone'];
  };
  const ids = new Set<string>();
  const boxes = new Map<string, Array<{ left: number; top: number; right: number; bottom: number }>>();
  const nodes = data.nodes.map((raw): VisualNode => {
    const node = object(raw);
    const id = text(node.id, LIMITS.nodeId, 'node id');
    if (ids.has(id)) throw new Error('Composition node ids must be unique.');
    ids.add(id);
    const kind = String(node.kind);
    if (!NODE_KINDS.includes(kind)) throw new Error(`Invalid composition node kind "${kind}" on node "${id}". Use panel, text, icon, image or asset.`);
    const icon = node.icon ?? '';
    if (!(VISUAL_ICON_IDS as readonly string[]).includes(String(icon))) {
      throw new Error(`Invalid composition icon "${String(icon)}" on node "${id}". Use "", ${VISUAL_ICON_IDS.filter(Boolean).join(', ')}.`);
    }
    if (kind === 'asset') {
      if (!(VISUAL_ASSET_IDS as readonly string[]).includes(String(node.asset))) throw new Error(`Invalid composition asset "${String(node.asset)}" on node "${id}". Use ${VISUAL_ASSET_IDS.join(', ')}.`);
    } else if (node.asset !== undefined) throw new Error(`Composition node "${id}" can only name an asset when its kind is "asset".`);
    if (node.role !== undefined && (!['hero', 'primary', 'secondary'].includes(String(node.role)) || !['panel', 'icon', 'asset'].includes(kind))) {
      throw new Error(`Invalid composition role on node "${id}". Use hero, primary or secondary on a panel, icon or asset node; text nodes use size.`);
    }
    const x = pattern ? number(node.x, -1200, 3200) : number(node.x, CONTENT_AREA.left, CONTENT_AREA.right);
    const y = pattern ? number(node.y, -1200, 2400) : number(node.y, CONTENT_AREA.top, CONTENT_AREA.lastTop);
    const width = pattern ? number(node.width, 1, 2400) : number(node.width, CONTENT_AREA.minSize, CONTENT_AREA.maxWidth);
    const height = pattern ? number(node.height, 1, 2400) : number(node.height, CONTENT_AREA.minSize, CONTENT_AREA.maxHeight);
    // Pattern-generated geometry is trusted: the engine may overrun the content area and the renderer scales the whole scene to fit.
    if (!pattern && (x + width > CONTENT_AREA.right || y + height > CONTENT_AREA.bottom)) throw new Error('Composition nodes must stay inside the presentation content area.');
    if (node.entrance !== undefined && !['fade', 'rise', 'left', 'right', 'scale', 'wipe'].includes(String(node.entrance))) throw new Error('Invalid composition entrance.');
    if (node.emphasis !== undefined && !['highlight', 'underline', 'strike'].includes(String(node.emphasis))) throw new Error('Invalid composition emphasis.');
    if (node.size !== undefined && !['xl', 'l', 'm', 's'].includes(String(node.size))) throw new Error('Invalid composition text size.');
    const appears = reveal(node.reveal);
    const placed = [{ left: x, top: y, right: x + width, bottom: y + height }];
    const states = node.states === undefined ? undefined : ((): VisualNodeState[] => {
      if (!Array.isArray(node.states) || !node.states.length || node.states.length > NODE_STATES.perNode) throw new Error(`Node "${id}" states need 1–${NODE_STATES.perNode} entries.`);
      let previous = appears, left = x, top = y, scale = 1;
      return node.states.map((entry): VisualNodeState => {
        const state = object(entry);
        const at = reveal(state.at);
        if (at <= previous) throw new Error(`State reveals on node "${id}" must increase and come after the node appears (reveal ${appears}).`);
        previous = at;
        const result: VisualNodeState = { at };
        if (state.x !== undefined) result.x = number(state.x, CONTENT_AREA.left, CONTENT_AREA.right);
        if (state.y !== undefined) result.y = number(state.y, CONTENT_AREA.top, CONTENT_AREA.lastTop);
        if (state.scale !== undefined) result.scale = number(state.scale, NODE_STATES.minScale, NODE_STATES.maxScale);
        if (state.opacity !== undefined) result.opacity = number(state.opacity, 0, 1);
        if (state.focus !== undefined) {
          if (typeof state.focus !== 'boolean' || !['panel', 'icon', 'asset'].includes(kind)) throw new Error(`Only panel, icon and asset nodes can take focus; node "${id}" cannot.`);
          result.focus = state.focus;
        }
        if (Object.keys(result).length === 1) throw new Error(`A state on node "${id}" at reveal ${at} must change position, scale, opacity or focus.`);
        left = result.x ?? left; top = result.y ?? top; scale = result.scale ?? scale;
        const w = width * scale, h = height * scale;
        const box = { left: left + (width - w) / 2, top: top + (height - h) / 2, right: left + (width + w) / 2, bottom: top + (height + h) / 2 };
        if (box.left < CONTENT_AREA.left || box.top < CONTENT_AREA.top || box.right > CONTENT_AREA.right || box.bottom > CONTENT_AREA.bottom) {
          throw new Error(`The state at reveal ${at} moves node "${id}" outside the presentation content area.`);
        }
        placed.push(box);
        return result;
      });
    })();
    boxes.set(id, placed);
    return { id, kind: kind as VisualNode['kind'], x, y, width, height,
      label: text(node.label, LIMITS.nodeLabel, 'node label', true), detail: text(node.detail, LIMITS.nodeDetail, 'node detail', true),
      icon: icon as VisualNode['icon'], tone: tone(node.tone), reveal: appears,
      ...(kind === 'asset' ? { asset: node.asset as NonNullable<VisualNode['asset']> } : {}),
      ...(node.role === undefined ? {} : { role: node.role as NonNullable<VisualNode['role']> }),
      ...(states === undefined ? {} : { states }),
      ...(node.entrance === undefined ? {} : { entrance: node.entrance as NonNullable<VisualNode['entrance']> }),
      ...(node.emphasis === undefined ? {} : { emphasis: node.emphasis as NonNullable<VisualNode['emphasis']> }),
      ...(node.size === undefined ? {} : { size: node.size as NonNullable<VisualNode['size']> }),
      ...(node.kicker === undefined || node.kicker === '' ? {} : { kicker: text(node.kicker, LIMITS.kicker, 'node kicker') }) };
  });
  const links = data.links.map((raw): VisualLink => {
    const link = object(raw);
    const from = text(link.from, LIMITS.nodeId, 'connection source'), to = text(link.to, LIMITS.nodeId, 'connection target');
    if (!ids.has(from) || !ids.has(to) || from === to || !['solid', 'dashed'].includes(String(link.style))) throw new Error('Invalid composition connection.');
    const at = reveal(link.reveal);
    if (nodes.some(node => (node.id === from || node.id === to) && node.reveal > at)) throw new Error('Connections cannot appear before their endpoints.');
    for (const end of [from, to]) {
      const moves = nodes.find(node => node.id === end)?.states?.some(state => state.x !== undefined || state.y !== undefined || state.scale !== undefined || state.opacity !== undefined);
      if (moves) throw new Error(`Node "${end}" is connected, so its states can only change focus: connections do not follow nodes that move, scale or fade.`);
    }
    if (link.motion !== undefined && !['draw', 'flow'].includes(String(link.motion))) throw new Error('Invalid composition connection motion.');
    if (link.route !== undefined && !['direct', 'arc'].includes(String(link.route))) throw new Error('Invalid composition connection route.');
    for (const port of [link.fromPort, link.toPort]) {
      if (port !== undefined && (typeof port !== 'string' || !['top', 'right', 'bottom', 'left'].includes(port))) throw new Error('Invalid composition connection port.');
    }
    return { from, to, label: text(link.label, LIMITS.nodeId, 'connection label', true), tone: tone(link.tone), reveal: at, style: link.style as VisualLink['style'],
      ...(link.motion === undefined ? {} : { motion: link.motion as NonNullable<VisualLink['motion']> }),
      ...(link.route === undefined ? {} : { route: link.route as NonNullable<VisualLink['route']> }),
      ...(link.fromPort === undefined ? {} : { fromPort: link.fromPort as NonNullable<VisualLink['fromPort']> }),
      ...(link.toPort === undefined ? {} : { toPort: link.toPort as NonNullable<VisualLink['toPort']> }) };
  });
  if (presenter && data.frame === 'around-presenter') {
    const area = PRESENTER_VIDEO_AREA;
    for (const [id, placed] of boxes) {
      if (placed.some(box => box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top)) {
        throw new Error(`Node "${id}" overlaps the presenter video (x ${area.left}–${area.right}, y ${area.top}–${area.bottom}). Keep framed graphics in the free area left of it or above it.`);
      }
    }
  }
  return { label: text(data.label, LIMITS.sceneLabel, 'scene label', true), imagePrompt: text(data.imagePrompt, LIMITS.imagePrompt, 'image brief', true), nodes, links,
    ...(data.imageTreatment === undefined ? {} : { imageTreatment: data.imageTreatment as NonNullable<VisualComposition['imageTreatment']> }),
    ...(data.frame === undefined ? {} : { frame: 'around-presenter' as const }),
    ...(pattern ? { pattern } : {}) };
}
export function parseVisualArtwork(value: unknown): VisualArtwork {
  const input = object(value);
  if (!Array.isArray(input.shapes) || !input.shapes.length || input.shapes.length > LIMITS.shapes) throw new Error('An illustration needs 1–32 shapes.');
  const number = (value: unknown, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid illustration geometry.');
    return value;
  };
  return { description: text(input.description, LIMITS.description, 'illustration description'), shapes: input.shapes.map(value => {
    const shape = object(value);
    if (!['circle', 'rect', 'path'].includes(String(shape.kind)) || !['teal', 'blue', 'purple', 'neutral'].includes(String(shape.tone))) throw new Error('Invalid illustration shape or tone.');
    const d = text(shape.d, LIMITS.path, 'illustration path', true);
    if (shape.kind === 'path' && (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/.test(d) || !/^[Mm]/.test(d))) throw new Error('Invalid illustration path.');
    return { kind: shape.kind as VisualArtwork['shapes'][number]['kind'], tone: shape.tone as VisualArtwork['shapes'][number]['tone'],
      x: number(shape.x, ART_AREA.minX, ART_AREA.maxX), y: number(shape.y, ART_AREA.minY, ART_AREA.maxY),
      width: number(shape.width, 0, ART_AREA.maxX), height: number(shape.height, 0, ART_AREA.maxY), radius: number(shape.radius, 0, ART_AREA.maxRadius),
      opacity: number(shape.opacity, ART_AREA.minOpacity, 1), d };
  }) };
}
export function scriptVisualSource(section: VisualScriptBlock): string {
  const references: Array<{ type: string; id: string }> = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (item.type === 'noteMention' || item.type === 'entityMention') {
      const props = object(item.props);
      references.push({ type: item.type === 'noteMention' ? 'note' : String(props.entityType), id: String(props.noteId ?? props.entityId) });
      return;
    }
    Object.values(item).forEach(walk);
  };
  walk(section.children ?? []);
  const blocks = visualSourceBlocks(section);
  return JSON.stringify(references.length ? { blocks, references } : blocks);
}
export function visualSpokenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(visualSpokenText).join('');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (item.type === 'scriptCue') return object(item.props).cue === 'beat' ? 'BEAT' : 'PAUSE';
  if (item.type === 'hardBreak') return '\n';
  if (typeof item.text === 'string') return item.text.replace(/\r\n?/g, '\n');
  return visualSpokenText(item.content);
}
function visualBlocks(section: VisualScriptBlock): Array<{ id: string; text: string }> {
  const walk = (blocks: VisualScriptBlock[]): Array<{ id: string; text: string }> => blocks.flatMap(block => [
    ...(block.type !== 'heading' && block.id ? [{ id: block.id, text: visualSpokenText(block.content) }] : []),
    ...walk(block.children ?? []),
  ]);
  return walk(section.children ?? []);
}
export function visualSourceBlocks(section: VisualScriptBlock): Array<{ id: string; text: string }> {
  return visualBlocks(section).filter(block => block.text.trim());
}
function layoutFreeSource(source: string): string | null {
  try {
    const parsed: unknown = JSON.parse(source);
    const value = Array.isArray(parsed) ? { blocks: parsed, references: [] } : object(parsed);
    if (!Array.isArray(value.blocks)) return null;
    const spoken = value.blocks.map(block => {
      const text = block && typeof block === 'object' ? (block as Record<string, unknown>).text : undefined;
      return typeof text === 'string' ? text : '';
    }).join(' ').replace(/\s+/g, ' ').trim();
    return JSON.stringify({ spoken, references: value.references ?? [] });
  } catch { return null; }
}
/** Visuals stay current when only layout changed: blank lines, line breaks or a paragraph split into several blocks. */
export function visualSourceCurrent(source: string, section: VisualScriptBlock): boolean {
  const current = scriptVisualSource(section);
  if (source === current) return true;
  const saved = layoutFreeSource(source);
  return saved !== null && saved === layoutFreeSource(current);
}
export interface ResolvedVisualCue extends VisualCue { index: number; offset: number }
/** Resolves a cue to the current spoken block, following text that a layout edit moved to a new block id. */
export function visualCueResolver(section: VisualScriptBlock): (cue: VisualCue) => ResolvedVisualCue | null {
  const all = visualBlocks(section);
  const spoken = all.filter(block => block.text.trim());
  const starts: number[] = [];
  let length = 0;
  for (const block of spoken) { starts.push(length); length += block.text.length + 1; }
  const joined = spoken.map(block => block.text).join('\n');
  return cue => {
    const index = spoken.findIndex(block => block.id === cue.blockId);
    const block = spoken[index];
    if (block && (!cue.quote || block.text.split(cue.quote).length === LIMITS.uniqueQuoteParts)) {
      return { ...cue, index, offset: cue.quote ? block.text.indexOf(cue.quote) : 0 };
    }
    const original = all.findIndex(item => item.id === cue.blockId);
    const following = original < 0 ? undefined : all.slice(original).find(item => item.text.trim());
    const next = following ? spoken.indexOf(following) : -1;
    if (next < 0) return null;
    if (!cue.quote) return { blockId: spoken[next]!.id, quote: '', index: next, offset: 0 };
    const words = cue.quote.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi');
    pattern.lastIndex = starts[next]!;
    const match = pattern.exec(joined);
    if (!match) return null;
    let at = spoken.length - 1;
    while (at > 0 && starts[at]! > match.index) at--;
    const target = spoken[at]!;
    const offset = match.index - starts[at]!;
    const quote = match[0].slice(0, target.text.length - offset).trimEnd();
    if (target.text.split(quote).length !== LIMITS.uniqueQuoteParts) return null;
    return { blockId: target.id, quote, index: at, offset };
  };
}
export function parseScriptVisuals(value: unknown, section?: VisualScriptBlock): ScriptVisuals {
  const input = object(typeof value === 'string' ? JSON.parse(value) : value);
  if (input.version !== 1 || !Array.isArray(input.scenes) || input.scenes.length > LIMITS.scenes) throw new Error('Invalid visual scene list (maximum 12 per section).');
  const source = text(input.source, LIMITS.source, 'source', true);
  const resolve = section ? visualCueResolver(section) : undefined;
  const cue = (value: unknown): VisualCue => {
    const data = object(value);
    const result = { blockId: text(data.blockId, LIMITS.id, 'cue block'), quote: text(data.quote, LIMITS.quote, 'cue quotation', true) };
    if (resolve && !resolve(result)) {
      throw new Error(`A visual cue must identify an existing spoken block and a unique exact quotation${result.quote ? ` ("${result.quote}")` : ''}.`);
    }
    return result;
  };
  const ids = new Set<string>();
  const scenes = input.scenes.map((value): ScriptVisualScene => {
    const scene = object(value);
    const template = VISUAL_TEMPLATES.find(template => template === scene.template);
    if (!template || !Array.isArray(scene.items) || scene.items.length > LIMITS.items) throw new Error('Invalid visual template or item list.');
    if (!scene.composition && template === 'comparison' && scene.items.length !== LIMITS.comparisonSides) throw new Error('A comparison requires exactly two sides.');
    if (!scene.composition && ['concept', 'steps', 'statistic'].includes(template) && !scene.items.length) throw new Error('This visual template requires content items.');
    const id = text(scene.id, LIMITS.id, 'scene id');
    if (ids.has(id)) throw new Error('Visual scene ids must be unique.');
    ids.add(id);
    const imageUrl = text(scene.imageUrl, LIMITS.imageUrl, 'image URL', true);
    if (scene.layout !== undefined && !['hero', 'split', 'diagram'].includes(String(scene.layout))) throw new Error('Invalid visual layout.');
    if (scene.presenterLayout !== undefined && typeof scene.presenterLayout !== 'boolean') throw new Error('Invalid presenter layout.');
    if (scene.brandMark !== undefined && (scene.brandMark !== 'ibm-8bar' || template !== 'close')) throw new Error('Invalid closing brand mark.');
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new Error('Visual images require an HTTPS URL.');
    if (template === 'image' && !imageUrl && !scene.composition) throw new Error('An image scene requires an existing image.');
    let composition: VisualComposition | undefined;
    try {
      composition = scene.composition === undefined ? undefined
        : parseVisualComposition(scene.composition, template === 'close' ? 0 : scene.items.length, template === 'title' || template === 'close', scene.presenterLayout === true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid visual data.';
      throw new Error(reason.startsWith(`Scene "`) ? reason : `Scene "${id}": ${reason}`);
    }
    if (composition?.imageTreatment && (!['title', 'image'].includes(template) || (!imageUrl && !composition.imagePrompt) || scene.artwork)) {
      throw new Error('Full-screen or blended imagery belongs to a static title/image scene with a supplied image or image brief.');
    }
    if (template === 'close' && (imageUrl || scene.artwork !== undefined || composition?.nodes.length || composition?.imagePrompt
      || scene.items.length > LIMITS.closeMarks)) {
      throw new Error('An end page is a typographic close: no imagery, nodes or connections, and at most two emphasised phrases.');
    }
    const title = text(scene.title, LIMITS.title, 'title'), subtitle = text(scene.subtitle, LIMITS.subtitle, 'subtitle', true);
    const items = scene.items.map(value => {
      const item = object(value);
      return { label: text(item.label, LIMITS.nodeLabel, 'item label'), detail: text(item.detail, LIMITS.itemDetail, 'item detail', true), cue: cue(item.cue) };
    });
    const loose = template === 'close' && items.find(item => !title.includes(item.label) && !subtitle.includes(item.label));
    if (loose) throw new Error(`End-page emphasis "${loose.label}" must be an exact phrase from the closing statement or its setup line.`);
    return { id, template, title, subtitle,
      cue: cue(scene.cue), imageUrl, imageAlt: text(scene.imageAlt, LIMITS.description, 'image description', template !== 'image'),
      ...(scene.artwork === undefined ? {} : { artwork: parseVisualArtwork(scene.artwork) }),
      ...(composition === undefined ? {} : { composition }),
      ...(scene.layout === undefined ? {} : { layout: scene.layout as NonNullable<ScriptVisualScene['layout']> }),
      ...(scene.presenterLayout === undefined ? {} : { presenterLayout: scene.presenterLayout }),
      ...(scene.brandMark === undefined ? {} : { brandMark: scene.brandMark }),
      items };
  });
  if (resolve) {
    const position = (cue: VisualCue): number => {
      const resolved = resolve(cue)!;
      return resolved.index * LIMITS.cueStride + resolved.offset;
    };
    let previous = -1;
    let previousCue: VisualCue | null = null;
    for (const scene of scenes) {
      const start = position(scene.cue);
      if (start < previous) throw new Error(`Visual scenes must follow script order: scene "${scene.id}" cue ${JSON.stringify(scene.cue)} is before the preceding reveal ${JSON.stringify(previousCue)}. Move this scene's cue to that position or later.`);
      previous = start;
      previousCue = scene.cue;
      for (const item of scene.items) {
        const next = position(item.cue);
        if (next < previous) throw new Error(`Visual reveals must follow script order within their scene: scene "${scene.id}", item "${item.label}" cue ${JSON.stringify(item.cue)} is before ${JSON.stringify(previousCue)}. Choose an exact quote at or after the previous cue, or use that same cue for simultaneous reveal.`);
        previous = next;
        previousCue = item.cue;
      }
    }
  }
  return { version: 1, source, scenes };
}
export function readSectionVisuals(section: VisualScriptBlock): ScriptVisuals | null {
  const raw = section.props?.scriptVisuals;
  return typeof raw === 'string' && raw ? parseScriptVisuals(raw) : null;
}
import type { VisualComposition, VisualNode, VisualNodeState, VisualLink, VisualPattern } from '../types/visualComposition.js';
import { layoutVisualPattern, parseVisualPattern, VISUAL_PATTERN_GUIDE, VISUAL_PATTERN_KINDS } from './visualPatterns.js';

export type { VisualComposition } from '../types/visualComposition.js';
