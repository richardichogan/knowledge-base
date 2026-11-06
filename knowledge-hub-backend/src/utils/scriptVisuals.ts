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
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new Error(`Invalid visual ${label}.`);
  return value;
}
export function parseVisualComposition(value: unknown, reveals: number, titleOnly = false): VisualComposition {
  const data = object(value);
  if (data.imageTreatment !== undefined && data.imageTreatment !== 'full' && data.imageTreatment !== 'blend') throw new Error('Invalid header image treatment.');
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
  const nodes = data.nodes.map((raw): VisualNode => {
    const node = object(raw);
    const id = text(node.id, LIMITS.nodeId, 'node id');
    if (ids.has(id)) throw new Error('Composition node ids must be unique.');
    ids.add(id);
    if (!['panel', 'text', 'icon', 'image'].includes(String(node.kind))) throw new Error(`Invalid composition node kind "${String(node.kind)}" on node "${id}". Use panel, text or icon.`);
    const icon = node.icon ?? '';
    if (!['', 'person', 'worker', 'document', 'check', 'system', 'arrow', 'boundary'].includes(String(icon))) {
      throw new Error(`Invalid composition icon "${String(icon)}" on node "${id}". Use "", person, worker, document, check, system, arrow or boundary.`);
    }
    const x = number(node.x, CONTENT_AREA.left, CONTENT_AREA.right), y = number(node.y, CONTENT_AREA.top, CONTENT_AREA.lastTop);
    const width = number(node.width, CONTENT_AREA.minSize, CONTENT_AREA.maxWidth), height = number(node.height, CONTENT_AREA.minSize, CONTENT_AREA.maxHeight);
    if (x + width > CONTENT_AREA.right || y + height > CONTENT_AREA.bottom) throw new Error('Composition nodes must stay inside the presentation content area.');
    if (node.entrance !== undefined && !['fade', 'rise', 'left', 'right', 'scale', 'wipe'].includes(String(node.entrance))) throw new Error('Invalid composition entrance.');
    if (node.emphasis !== undefined && !['highlight', 'underline', 'strike'].includes(String(node.emphasis))) throw new Error('Invalid composition emphasis.');
    if (node.size !== undefined && !['xl', 'l', 'm', 's'].includes(String(node.size))) throw new Error('Invalid composition text size.');
    return { id, kind: node.kind as VisualNode['kind'], x, y, width, height,
      label: text(node.label, LIMITS.nodeLabel, 'node label', true), detail: text(node.detail, LIMITS.nodeDetail, 'node detail', true),
      icon: icon as VisualNode['icon'], tone: tone(node.tone), reveal: reveal(node.reveal),
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
  return { label: text(data.label, LIMITS.sceneLabel, 'scene label', true), imagePrompt: text(data.imagePrompt, LIMITS.imagePrompt, 'image brief', true), nodes, links,
    ...(data.imageTreatment === undefined ? {} : { imageTreatment: data.imageTreatment as NonNullable<VisualComposition['imageTreatment']> }) };
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
    const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
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
    const composition = scene.composition === undefined ? undefined
      : parseVisualComposition(scene.composition, template === 'close' ? 0 : scene.items.length, template === 'title' || template === 'close');
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
import type { VisualComposition, VisualNode, VisualLink } from '../types/visualComposition.js';

export type { VisualComposition } from '../types/visualComposition.js';
