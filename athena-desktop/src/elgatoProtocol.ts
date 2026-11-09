export const ELGATO_PORT = 43129;
export const COMMANDS = [
  'open-athena', 'new-note', 'new-diagram', 'speak', 'present-note',
  'play', 'pause', 'toggle-play', 'stop', 'faster', 'slower', 'text-larger', 'text-smaller',
  'stop-presenting',
] as const;
export type DesktopCommand = typeof COMMANDS[number];
export interface PresentationVideoState extends VisualVideoState { noteId: string | null; available: boolean }
export function parseVisualVideoMode(value: unknown): VisualVideoMode {
  if (value !== 'guide' && value !== 'camera' && value !== 'off') throw new Error('Choose Guide, Camera or Off for presenter video.');
  return value;
}
export interface CommandRequest { id: string; command: DesktopCommand; issuedAt: number }
export interface PresentationState {
  sessionId: string;
  noteId: string | null;
  title: string;
  status: 'ready' | 'playing' | 'paused' | 'ended' | 'disconnected';
  speed: number;
  fontSize: number;
  progress: number;
  displayId: number | null;
  mirror: boolean;
  flip: boolean;
  opacity: number;
  error: string | null;
}
export const PRESENTATION_STYLES = [
  'bold', 'italic', 'underline', 'strike', 'code',
  'colour-teal', 'colour-yellow', 'colour-pink', 'cue-pause', 'cue-beat',
] as const;
export type PresentationStyle = typeof PRESENTATION_STYLES[number];
export interface PresentationRun { text: string; styles: PresentationStyle[] }
export interface PresentationArtwork {
  description: string;
  shapes: Array<{ kind: 'circle' | 'rect' | 'path'; x: number; y: number; width: number; height: number; radius: number;
    d: string; tone: 'teal' | 'blue' | 'purple' | 'neutral'; opacity: number }>;
}
export interface PresentationVisualScene {
  id: string; template: 'title' | 'statistic' | 'comparison' | 'steps' | 'concept' | 'image' | 'close';
  title: string; subtitle: string; at: number; imageUrl: string; imageAlt: string;
  items: Array<{ label: string; detail: string; at: number }>;
  artwork?: PresentationArtwork;
  layout?: 'hero' | 'split' | 'diagram';
  composition?: VisualComposition;
  presenterLayout?: boolean;
  brandMark?: 'ibm-8bar';
  /** Index of the script section the scene belongs to; a change of section lengthens the visual cross-fade. */
  section?: number;
}
export interface PresentationScript { noteId: string; title: string; text: string; runs?: PresentationRun[]; visuals?: PresentationVisualScene[] }

export const PRESENTATION_ASSET_IDS = ['foundation', 'workforce-pair', 'copilot', 'agent', 'automation', 'system', 'owner',
  'outcome', 'boundary', 'layers', 'process', 'plan'];
const PRESENTATION_ICONS = ['', 'person', 'worker', 'document', 'check', 'system', 'arrow', 'boundary', 'clock', 'quality', 'coin', 'gauge'];

export function parsePresentationVisuals(value: unknown, length: number): PresentationVisualScene[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 240) throw new Error('Invalid presentation visuals.');
  const string = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || value.length > max) throw new Error('Invalid presentation visual text.');
    return value;
  };
  const composition = (value: unknown, reveals: number, titleOnly: boolean): VisualComposition => {
    if (!value || typeof value !== 'object') throw new Error('Invalid presentation composition.');
    const data = value as Record<string, unknown>;
    if (data.imageTreatment !== undefined && data.imageTreatment !== 'full' && data.imageTreatment !== 'blend') throw new Error('Invalid header image treatment.');
    if (data.frame !== undefined && data.frame !== 'around-presenter') throw new Error('Invalid presentation composition frame.');
    if (data.pattern !== undefined && (data.imageTreatment !== undefined || data.frame !== undefined)) throw new Error('A pattern composition cannot also set imageTreatment or frame.');
    if (!Array.isArray(data.nodes) || (!data.nodes.length && !data.imageTreatment && !titleOnly) || data.nodes.length > 24
      || !Array.isArray(data.links) || data.links.length > 24) throw new Error('Invalid presentation composition elements.');
    if (data.imageTreatment && (data.nodes.length || data.links.length || reveals)) throw new Error('Header imagery cannot be mixed with animated diagram content.');
    if (!data.nodes.length && (data.links.length || reveals)) throw new Error('A title-only composition cannot contain connections or builds.');
    const number = (value: unknown, min: number, max: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid presentation composition geometry.');
      return value;
    };
    const reveal = (value: unknown): number => {
      const result = number(value, 0, reveals);
      if (!Number.isInteger(result)) throw new Error('Invalid presentation composition reveal.');
      return result;
    };
    const tone = (value: unknown): VisualNode['tone'] => {
      if (!['teal', 'blue', 'purple', 'neutral', 'warning', 'success'].includes(String(value))) throw new Error('Invalid presentation composition tone.');
      return value as VisualNode['tone'];
    };
    const pattern = ((): VisualPattern | undefined => {
      if (data.pattern === undefined) return undefined;
      if (!data.pattern || typeof data.pattern !== 'object' || Array.isArray(data.pattern)) throw new Error('Invalid presentation composition pattern.');
      const raw = data.pattern as Record<string, unknown>;
      if (!['flow', 'converge', 'branch', 'stack', 'compare', 'hub', 'cycle', 'statement', 'tree', 'tiers'].includes(String(raw.type))
        || !['icon', 'panel', 'text', 'block'].includes(String(raw.kind))) throw new Error('Invalid presentation composition pattern.');
      if (!Array.isArray(raw.subjects) || !raw.subjects.length || raw.subjects.length > 24) throw new Error('Invalid presentation composition pattern.');
      const subjectIds = new Set<string>();
      const subjects = raw.subjects.map((entry: unknown): VisualPatternSubject => {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid presentation composition pattern subject.');
        const subject = entry as Record<string, unknown>;
        const id = string(subject.id, 80);
        if (!id.trim() || subjectIds.has(id)) throw new Error('Invalid presentation composition pattern subject id.');
        subjectIds.add(id);
        if (subject.icon !== undefined && !PRESENTATION_ICONS.includes(String(subject.icon))) throw new Error('Invalid presentation composition pattern icon.');
        if (subject.asset !== undefined && !PRESENTATION_ASSET_IDS.includes(String(subject.asset))) throw new Error('Invalid presentation composition pattern asset.');
        if (subject.emphasis !== undefined && !['highlight', 'underline', 'strike'].includes(String(subject.emphasis))) throw new Error('Invalid presentation composition pattern emphasis.');
        return { id, label: string(subject.label, 120), detail: string(subject.detail, 240), tone: tone(subject.tone), reveal: reveal(subject.reveal),
          ...(subject.asset === undefined ? {} : { asset: subject.asset as NonNullable<VisualPatternSubject['asset']> }),
          ...(subject.icon === undefined ? {} : { icon: subject.icon as NonNullable<VisualPatternSubject['icon']> }),
          ...(subject.kicker === undefined ? {} : { kicker: string(subject.kicker, 40) }),
          ...(subject.emphasis === undefined ? {} : { emphasis: subject.emphasis as NonNullable<VisualPatternSubject['emphasis']> }) };
      });
      const focus = raw.focus === undefined ? undefined : string(raw.focus, 80);
      if (focus !== undefined && !subjectIds.has(focus)) throw new Error('Invalid presentation composition pattern focus.');
      return { type: raw.type as VisualPattern['type'], kind: raw.kind as VisualPattern['kind'],
        ...(focus === undefined ? {} : { focus }), subjects };
    })();
    const ids = new Set<string>();
    const nodes = data.nodes.map((raw: unknown): VisualNode => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid presentation composition node.');
      const node = raw as Record<string, unknown>;
      const id = string(node.id, 80);
      if (!id.trim() || ids.has(id)) throw new Error('Invalid presentation composition node id.');
      ids.add(id);
      const kind = String(node.kind);
      if (!['panel', 'text', 'icon', 'image', 'asset', 'stat', 'block', 'quote'].includes(kind) || !PRESENTATION_ICONS.includes(String(node.icon))) throw new Error('Invalid presentation composition node type.');
      if (kind === 'asset' ? !PRESENTATION_ASSET_IDS.includes(String(node.asset)) : node.asset !== undefined) throw new Error('Invalid presentation composition asset.');
      if (node.role !== undefined && (!['hero', 'primary', 'secondary'].includes(String(node.role)) || !['panel', 'icon', 'asset', 'stat', 'block'].includes(kind))) throw new Error('Invalid presentation composition role.');
      const x = pattern ? number(node.x, -1200, 3200) : number(node.x, 80, 1520);
      const y = pattern ? number(node.y, -1200, 2400) : number(node.y, 240, 790);
      const width = pattern ? number(node.width, 1, 2400) : number(node.width, 40, 1440);
      const height = pattern ? number(node.height, 1, 2400) : number(node.height, 40, 550);
      // Pattern-generated geometry is trusted: the layout engine may overrun the stage and the renderer scales the whole scene to fit.
      if (!pattern && (x + width > 1520 || y + height > 800)) throw new Error('Presentation composition is outside the stage.');
      if (node.entrance !== undefined && !['fade', 'rise', 'left', 'right', 'scale', 'wipe'].includes(String(node.entrance))) throw new Error('Invalid presentation composition entrance.');
      if (node.emphasis !== undefined && !['highlight', 'underline', 'strike'].includes(String(node.emphasis))) throw new Error('Invalid presentation composition emphasis.');
      if (node.size !== undefined && !['xl', 'l', 'm', 's'].includes(String(node.size))) throw new Error('Invalid presentation composition text size.');
      const appears = reveal(node.reveal);
      const states = node.states === undefined ? undefined : ((): VisualNodeState[] => {
        if (!Array.isArray(node.states) || !node.states.length || node.states.length > 4) throw new Error('Invalid presentation composition states.');
        let previous = appears, left = x, top = y, scale = 1;
        return node.states.map((entry: unknown): VisualNodeState => {
          if (!entry || typeof entry !== 'object') throw new Error('Invalid presentation composition state.');
          const state = entry as Record<string, unknown>;
          const at = reveal(state.at);
          if (at <= previous) throw new Error('Invalid presentation composition state order.');
          previous = at;
          const result: VisualNodeState = { at };
          if (state.x !== undefined) result.x = number(state.x, 80, 1520);
          if (state.y !== undefined) result.y = number(state.y, 240, 790);
          if (state.scale !== undefined) result.scale = number(state.scale, 0.5, 1.4);
          if (state.opacity !== undefined) result.opacity = number(state.opacity, 0, 1);
          if (state.focus !== undefined) {
            if (typeof state.focus !== 'boolean' || !['panel', 'icon', 'asset'].includes(kind)) throw new Error('Invalid presentation composition focus.');
            result.focus = state.focus;
          }
          if (Object.keys(result).length === 1) throw new Error('Invalid presentation composition state.');
          left = result.x ?? left; top = result.y ?? top; scale = result.scale ?? scale;
          const w = width * scale, h = height * scale;
          if (left + (width - w) / 2 < 80 || top + (height - h) / 2 < 240 || left + (width + w) / 2 > 1520 || top + (height + h) / 2 > 800) throw new Error('Presentation composition is outside the stage.');
          return result;
        });
      })();
      return { id, kind: kind as VisualNode['kind'], x, y, width, height,
        label: string(node.label, 120), detail: string(node.detail, 240), icon: node.icon as VisualNode['icon'],
        tone: tone(node.tone), reveal: appears,
        ...(kind === 'asset' ? { asset: node.asset as NonNullable<VisualNode['asset']> } : {}),
        ...(node.role === undefined ? {} : { role: node.role as NonNullable<VisualNode['role']> }),
        ...(states === undefined ? {} : { states }),
        ...(node.entrance === undefined ? {} : { entrance: node.entrance as NonNullable<VisualNode['entrance']> }),
        ...(node.emphasis === undefined ? {} : { emphasis: node.emphasis as NonNullable<VisualNode['emphasis']> }),
        ...(node.size === undefined ? {} : { size: node.size as NonNullable<VisualNode['size']> }),
        ...(node.kicker === undefined || node.kicker === '' ? {} : { kicker: string(node.kicker, 40) }) };
    });
    const links = data.links.map((raw: unknown): VisualLink => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid presentation composition connection.');
      const link = raw as Record<string, unknown>;
      const from = string(link.from, 80), to = string(link.to, 80), at = reveal(link.reveal);
      if (!ids.has(from) || !ids.has(to) || from === to || !['solid', 'dashed', 'line'].includes(String(link.style))
        || nodes.some(node => (node.id === from || node.id === to) && node.reveal > at)) throw new Error('Invalid presentation composition connection.');
      if (nodes.some(node => (node.id === from || node.id === to)
        && node.states?.some(state => state.x !== undefined || state.y !== undefined || state.scale !== undefined || state.opacity !== undefined))) {
        throw new Error('A connected presentation node can only change focus.');
      }
      if (link.motion !== undefined && !['draw', 'flow'].includes(String(link.motion))) throw new Error('Invalid presentation composition connection motion.');
      if (link.route !== undefined && !['direct', 'arc'].includes(String(link.route))) throw new Error('Invalid presentation composition connection route.');
      for (const port of [link.fromPort, link.toPort]) {
        if (port !== undefined && (typeof port !== 'string' || !['top', 'right', 'bottom', 'left'].includes(port))) throw new Error('Invalid presentation connection port.');
      }
      return { from, to, label: string(link.label, 80), tone: tone(link.tone), reveal: at, style: link.style as VisualLink['style'],
        ...(link.motion === undefined ? {} : { motion: link.motion as NonNullable<VisualLink['motion']> }),
        ...(link.route === undefined ? {} : { route: link.route as NonNullable<VisualLink['route']> }),
        ...(link.fromPort === undefined ? {} : { fromPort: link.fromPort as NonNullable<VisualLink['fromPort']> }),
        ...(link.toPort === undefined ? {} : { toPort: link.toPort as NonNullable<VisualLink['toPort']> }) };
    });
    return { label: string(data.label, 100), imagePrompt: string(data.imagePrompt, 1800), nodes, links,
      ...(data.imageTreatment === undefined ? {} : { imageTreatment: data.imageTreatment as NonNullable<VisualComposition['imageTreatment']> }),
      ...(data.frame === undefined ? {} : { frame: 'around-presenter' as const }),
      ...(pattern === undefined ? {} : { pattern }) };
  };
  const artwork = (value: unknown): PresentationArtwork => {
    if (!value || typeof value !== 'object') throw new Error('Invalid presentation artwork.');
    const data = value as Record<string, unknown>;
    if (!Array.isArray(data.shapes) || !data.shapes.length || data.shapes.length > 32) throw new Error('Invalid presentation artwork shapes.');
    const number = (value: unknown, min: number, max: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Invalid presentation artwork geometry.');
      return value;
    };
    const description = string(data.description, 500);
    if (!description.trim()) throw new Error('Presentation artwork needs a description.');
    return { description, shapes: data.shapes.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid presentation artwork shape.');
      const shape = raw as Record<string, unknown>;
      if (!['circle', 'rect', 'path'].includes(String(shape.kind)) || !['teal', 'blue', 'purple', 'neutral'].includes(String(shape.tone))) throw new Error('Invalid presentation artwork shape.');
      const d = string(shape.d, 2400);
      if (shape.kind === 'path' && (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/.test(d) || !/^[Mm]/.test(d))) throw new Error('Invalid presentation artwork path.');
      return { kind: shape.kind as PresentationArtwork['shapes'][number]['kind'], tone: shape.tone as PresentationArtwork['shapes'][number]['tone'],
        x: number(shape.x, -1600, 3200), y: number(shape.y, -900, 1800), width: number(shape.width, 0, 3200),
        height: number(shape.height, 0, 1800), radius: number(shape.radius, 0, 1600), opacity: number(shape.opacity, 0.05, 1), d };
    }) };
  };
  let previous = -1;
  const at = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < previous || value > length) throw new Error('Visual cues must follow the script.');
    previous = value; return value;
  };
  return value.map((raw: unknown): PresentationVisualScene => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid presentation scene.');
    const scene = raw as Record<string, unknown>;
    const template = ['title', 'statistic', 'comparison', 'steps', 'concept', 'image', 'close'].find(item => item === scene.template);
    if (!template || !Array.isArray(scene.items) || scene.items.length > 6) throw new Error('Invalid presentation visual template.');
    const imageUrl = string(scene.imageUrl, 2000);
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new Error('Invalid presentation image URL.');
    if (scene.layout !== undefined && !['hero', 'split', 'diagram'].includes(String(scene.layout))) throw new Error('Invalid presentation layout.');
    if (scene.presenterLayout !== undefined && typeof scene.presenterLayout !== 'boolean') throw new Error('Invalid presenter layout.');
    if (scene.brandMark !== undefined && (scene.brandMark !== 'ibm-8bar' || template !== 'close')) throw new Error('Invalid closing brand mark.');
    if (scene.section !== undefined && (typeof scene.section !== 'number' || !Number.isSafeInteger(scene.section) || scene.section < 0)) throw new Error('Invalid presentation section.');
    const composed = scene.composition === undefined ? undefined
      : composition(scene.composition, template === 'close' ? 0 : scene.items.length, template === 'title' || template === 'close');
    if (composed?.imageTreatment && (!['title', 'image'].includes(template) || !imageUrl || scene.artwork)) throw new Error('An image header needs a resolved image, without diagram animation.');
    return { id: string(scene.id, 100), template: template as PresentationVisualScene['template'],
      title: string(scene.title, 160), subtitle: string(scene.subtitle, 500), imageUrl, imageAlt: string(scene.imageAlt, 500),
      ...(scene.artwork === undefined ? {} : { artwork: artwork(scene.artwork) }),
      ...(composed === undefined ? {} : { composition: composed }),
      ...(scene.layout === undefined ? {} : { layout: scene.layout as NonNullable<PresentationVisualScene['layout']> }),
      ...(scene.presenterLayout === undefined ? {} : { presenterLayout: scene.presenterLayout }),
      ...(scene.brandMark === undefined ? {} : { brandMark: scene.brandMark }),
      ...(scene.section === undefined ? {} : { section: scene.section as number }),
      at: at(scene.at), items: scene.items.map((raw: unknown) => {
        if (!raw || typeof raw !== 'object') throw new Error('Invalid visual reveal.');
        const item = raw as Record<string, unknown>;
        return { label: string(item.label, 120), detail: string(item.detail, 400), at: at(item.at) };
      }) };
  });
}

export function parsePresentationRuns(value: unknown, text: string): PresentationRun[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500_000) throw new Error('The presentation formatting is invalid or too large.');
  let length = 0;
  const runs = value.map((item: unknown): PresentationRun => {
    if (!item || typeof item !== 'object') throw new Error('The presentation formatting is invalid.');
    const run = item as Record<string, unknown>;
    if (Object.keys(run).some(key => key !== 'text' && key !== 'styles') || typeof run.text !== 'string'
      || !Array.isArray(run.styles) || run.styles.length > PRESENTATION_STYLES.length
      || !run.styles.every((style: unknown) => PRESENTATION_STYLES.some(allowed => allowed === style))) {
      throw new Error('The presentation formatting is invalid.');
    }
    length += run.text.length;
    if (length > 500_000) throw new Error('The presentation formatting is too large.');
    const styles = run.styles;
    return { text: run.text, styles: PRESENTATION_STYLES.filter(style => styles.includes(style)) };
  });
  if (runs.map(run => run.text).join('') !== text) throw new Error('The formatted presentation does not match its script.');
  return runs;
}
export interface PresentationDisplay {
  id: number; label: string; width: number; height: number; scale: number; primary: boolean;
}
export interface DesktopCommandState {
  protocol: 1;
  presentation: PresentationState;
  recording: boolean;
  transcribing: boolean;
  error: string | null;
}
export function parseCommand(value: unknown, now = Date.now()): CommandRequest {
  if (!value || typeof value !== 'object') throw new Error('A command object is required.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['id', 'command', 'issuedAt'].includes(k))
    || typeof v.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(v.id)
    || typeof v.command !== 'string' || !COMMANDS.some(c => c === v.command)
    || typeof v.issuedAt !== 'number' || !Number.isFinite(v.issuedAt)
    || Math.abs(now - v.issuedAt) > 30_000) throw new Error('Unknown, invalid or expired command.');
  return { id: v.id, command: v.command as DesktopCommand, issuedAt: v.issuedAt };
}
export function initialPresentation(): PresentationState {
  return { sessionId: '', noteId: null, title: '', status: 'ready', speed: 80, fontSize: 64,
    progress: 0, displayId: null, mirror: false, flip: false, opacity: 100, error: null };
}
export function playbackCommand(state: PresentationState, command: DesktopCommand): PresentationState {
  const next = { ...state, error: null };
  switch (command) {
    case 'play': case 'toggle-play':
      if (state.displayId === null || !state.sessionId) throw new Error('Choose a script and connect an output display first.');
      next.status = command === 'toggle-play' && state.status === 'playing' ? 'paused' : 'playing';
      if (state.status === 'ended' || state.progress >= 1) next.progress = 0;
      break;
    case 'pause': next.status = 'paused'; break;
    case 'stop': next.status = 'ready'; next.progress = 0; break;
    case 'faster': next.speed = Math.min(300, state.speed + 2); break;
    case 'slower': next.speed = Math.max(10, state.speed - 2); break;
    case 'text-larger': next.fontSize = Math.min(96, state.fontSize + 4); break;
    case 'text-smaller': next.fontSize = Math.max(24, state.fontSize - 4); break;
    default: throw new Error('Not a playback command.');
  }
  return next;
}
import type { VisualComposition, VisualNode, VisualNodeState, VisualLink, VisualPattern, VisualPatternSubject, VisualVideoMode, VisualVideoState } from '../assets/visualComposition';
