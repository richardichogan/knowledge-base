export const VISUAL_TEMPLATES = ['title', 'statistic', 'comparison', 'steps', 'concept', 'image'] as const;
export const SCRIPT_VISUAL_SOURCE_BUDGET = 60_000;
export const SCRIPT_VISUAL_INSTRUCTION_LIMIT = 4000;
const LIMITS = {
  subjects: 24, id: 100, nodeId: 80, nodeLabel: 120, nodeDetail: 240,
  sceneLabel: 100, imagePrompt: 1800, shapes: 32, description: 500,
  path: 2400, scenes: 12, source: 500_000, quote: 300, items: 6,
  comparisonSides: 2, uniqueQuoteParts: 2, imageUrl: 2000, title: 160,
  subtitle: 500, itemDetail: 400, cueStride: 1_000_000,
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
export function parseVisualComposition(value: unknown, reveals: number): VisualComposition {
  const data = object(value);
  if (!Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > LIMITS.subjects
    || !Array.isArray(data.links) || data.links.length > LIMITS.subjects) throw new Error('A composition needs 1–24 nodes and at most 24 connections.');
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
    if (!['panel', 'text', 'icon', 'image'].includes(String(node.kind))
      || !['', 'person', 'worker', 'document', 'check', 'system', 'arrow', 'boundary'].includes(String(node.icon))) throw new Error('Invalid composition node or icon.');
    const x = number(node.x, CONTENT_AREA.left, CONTENT_AREA.right), y = number(node.y, CONTENT_AREA.top, CONTENT_AREA.lastTop);
    const width = number(node.width, CONTENT_AREA.minSize, CONTENT_AREA.maxWidth), height = number(node.height, CONTENT_AREA.minSize, CONTENT_AREA.maxHeight);
    if (x + width > CONTENT_AREA.right || y + height > CONTENT_AREA.bottom) throw new Error('Composition nodes must stay inside the presentation content area.');
    return { id, kind: node.kind as VisualNode['kind'], x, y, width, height,
      label: text(node.label, LIMITS.nodeLabel, 'node label', true), detail: text(node.detail, LIMITS.nodeDetail, 'node detail', true),
      icon: node.icon as VisualNode['icon'], tone: tone(node.tone), reveal: reveal(node.reveal) };
  });
  const links = data.links.map((raw): VisualLink => {
    const link = object(raw);
    const from = text(link.from, LIMITS.nodeId, 'connection source'), to = text(link.to, LIMITS.nodeId, 'connection target');
    if (!ids.has(from) || !ids.has(to) || from === to || !['solid', 'dashed'].includes(String(link.style))) throw new Error('Invalid composition connection.');
    const at = reveal(link.reveal);
    if (nodes.some(node => (node.id === from || node.id === to) && node.reveal > at)) throw new Error('Connections cannot appear before their endpoints.');
    return { from, to, label: text(link.label, LIMITS.nodeId, 'connection label', true), tone: tone(link.tone), reveal: at, style: link.style as VisualLink['style'] };
  });
  return { label: text(data.label, LIMITS.sceneLabel, 'scene label', true), imagePrompt: text(data.imagePrompt, LIMITS.imagePrompt, 'image brief', true), nodes, links };
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
export function visualSourceBlocks(section: VisualScriptBlock): Array<{ id: string; text: string }> {
  const walk = (blocks: VisualScriptBlock[]): Array<{ id: string; text: string }> => blocks.flatMap(block => [
    ...(block.type !== 'heading' && block.id && visualSpokenText(block.content).trim()
      ? [{ id: block.id, text: visualSpokenText(block.content) }] : []),
    ...walk(block.children ?? []),
  ]);
  return walk(section.children ?? []);
}
export function parseScriptVisuals(value: unknown, section?: VisualScriptBlock): ScriptVisuals {
  const input = object(typeof value === 'string' ? JSON.parse(value) : value);
  if (input.version !== 1 || !Array.isArray(input.scenes) || input.scenes.length > LIMITS.scenes) throw new Error('Invalid visual scene list (maximum 12 per section).');
  const source = text(input.source, LIMITS.source, 'source', true);
  const blocks = section ? visualSourceBlocks(section) : undefined;
  const cue = (value: unknown): VisualCue => {
    const data = object(value);
    const result = { blockId: text(data.blockId, LIMITS.id, 'cue block'), quote: text(data.quote, LIMITS.quote, 'cue quotation', true) };
    if (blocks) {
      const block = blocks.find(block => block.id === result.blockId);
      if (!block || result.quote && (block.text.split(result.quote).length !== LIMITS.uniqueQuoteParts)) {
        throw new Error('A visual cue must identify an existing spoken block and a unique exact quotation.');
      }
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
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new Error('Visual images require an HTTPS URL.');
    if (template === 'image' && !imageUrl && !scene.composition) throw new Error('An image scene requires an existing image.');
    return { id, template, title: text(scene.title, LIMITS.title, 'title'), subtitle: text(scene.subtitle, LIMITS.subtitle, 'subtitle', true),
      cue: cue(scene.cue), imageUrl, imageAlt: text(scene.imageAlt, LIMITS.description, 'image description', template !== 'image'),
      ...(scene.artwork === undefined ? {} : { artwork: parseVisualArtwork(scene.artwork) }),
      ...(scene.composition === undefined ? {} : { composition: parseVisualComposition(scene.composition, scene.items.length) }),
      ...(scene.layout === undefined ? {} : { layout: scene.layout as NonNullable<ScriptVisualScene['layout']> }),
      items: scene.items.map(value => {
        const item = object(value);
        return { label: text(item.label, LIMITS.nodeLabel, 'item label'), detail: text(item.detail, LIMITS.itemDetail, 'item detail', true), cue: cue(item.cue) };
      }) };
  });
  if (blocks) {
    const position = (cue: VisualCue): number => {
      const index = blocks.findIndex(block => block.id === cue.blockId);
      return index * LIMITS.cueStride + (cue.quote ? blocks[index]!.text.indexOf(cue.quote) : 0);
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
import type { VisualComposition, VisualNode, VisualLink } from '../../../athena-desktop/assets/visualComposition.js';

export type { VisualComposition } from '../../../athena-desktop/assets/visualComposition.js';
