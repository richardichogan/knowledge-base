import type { Pool } from 'pg';
import { IntegrationError, ValidationError } from '../types/errors.js';
import { apiJson, muralBoard, muralUploadUrl, pngDimensions, request, withToken } from './mural.js';

interface Point { x: number; y: number }
interface NativeObject extends Point {
  id: string; type: 'shape' | 'textbox' | 'area' | 'image'; shape: string; text: string;
  width: number; height: number; parentId: string | null; fill: string; stroke: string;
  strokeWidth: number; dotted: boolean; textColor: string; fontSize: number; align: 'left' | 'center' | 'right';
  image: Buffer | null; instruction: string; rotation: number;
}
interface NativeConnector {
  id: string; sourceId: string | null; targetId: string | null; points: Point[];
  route: 'straight' | 'orthogonal'; arrows: 'none' | 'start' | 'end' | 'both';
  stroke: string; strokeWidth: number; dashed: boolean; text: string; fontSize: number; label: Point;
}
const SHAPES = new Set(['rounded_square', 'rhombus_smart', 'terminator', 'document', 'rectangle', 'ellipse',
  'arrow_right', 'arrow_left', 'arrow_top', 'arrow_down', 'arrow_left_right']);
const MAX_OBJECTS = 200;
const MAX_COORDINATE = 1_000_000;
const MAX_IMAGE_BYTES = 20_971_520;
const MAX_TEXT_LENGTH = 20_000;
const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_SHAPE_NAME = 40;
const BASE64_SIZE_FACTOR = 1.4;
const MAX_STROKE = 7;
const MAX_FONT = 300;
const MAX_ROTATION = 359;
const MIN_POINTS = 2;
const MAX_POINTS = 200;
const RGB_HEX_LENGTH = 7;
const LABEL_WIDTH = 160;
const LABEL_HALF_WIDTH = 80;
const LABEL_MIN_HEIGHT = 24;
const LABEL_LINE_HEIGHT = 2;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid Mural diagram object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.length > max) throw new ValidationError('Invalid or oversized Mural diagram text.');
  return value;
}
function number(value: unknown, min = -MAX_COORDINATE, max = MAX_COORDINATE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ValidationError('Invalid Mural diagram geometry.');
  return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ValidationError('Unsupported Mural diagram option.');
  return value as T;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ValidationError('Invalid Mural diagram option.');
  return value;
}
function colour(value: unknown): string {
  if (typeof value !== 'string' || !/^#[A-F0-9]{8}$/i.test(value)) throw new ValidationError('Mural colours must use hex with alpha.');
  return value.toUpperCase();
}
function id(value: unknown): string {
  const result = text(value, MAX_ID_LENGTH);
  if (!result || !/^[\w-]+$/.test(result)) throw new ValidationError('Invalid Mural diagram element ID.');
  return result;
}
function point(value: unknown): Point {
  const p = object(value); return { x: number(p.x), y: number(p.y) };
}
const html = (value: string): string => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] ?? c).replace(/\r?\n/g, '<br>');

export function validateMuralDiagram(input: unknown): { board: ReturnType<typeof muralBoard>; title: string; objects: NativeObject[]; connectors: NativeConnector[] } {
  const body = object(input);
  const board = muralBoard(body.boardUrl), title = text(body.title, MAX_TITLE_LENGTH);
  if (!Array.isArray(body.objects) || !Array.isArray(body.connectors) || body.objects.length + body.connectors.length === 0
    || body.objects.length + body.connectors.length > MAX_OBJECTS) {
    throw new ValidationError(`Native Mural export supports 1-${MAX_OBJECTS} objects, including connectors, icons and annotations. Export a smaller diagram or turn off annotations.`);
  }
  let imageBytes = 0;
  const objects = body.objects.map((value): NativeObject => {
    const o = object(value), type = oneOf(o.type, ['shape', 'textbox', 'area', 'image'] as const);
    const shape = text(o.shape, MAX_SHAPE_NAME);
    if (type === 'shape' && !SHAPES.has(shape)) throw new ValidationError('Unsupported native Mural shape.');
    let image: Buffer | null = null;
    if (type === 'image') {
      if (typeof o.image !== 'string' || o.image.length > MAX_IMAGE_BYTES * BASE64_SIZE_FACTOR || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(o.image)) throw new ValidationError('Native Mural icons must be PNG images.');
      image = Buffer.from(o.image.slice('data:image/png;base64,'.length), 'base64');
      pngDimensions(image); imageBytes += image.length;
      if (imageBytes > MAX_IMAGE_BYTES) throw new ValidationError('Diagram icons exceed the 20 MiB total limit.');
    }
    return { id: id(o.id), type, shape, text: text(o.text), ...point(o), width: number(o.width, 1), height: number(o.height, 1),
      parentId: o.parentId === null ? null : id(o.parentId), fill: colour(o.fill), stroke: colour(o.stroke),
      strokeWidth: number(o.strokeWidth, 1, MAX_STROKE), dotted: bool(o.dotted), textColor: colour(o.textColor), fontSize: number(o.fontSize, 1, MAX_FONT),
      align: oneOf(o.align, ['left', 'center', 'right'] as const), image,
      instruction: o.instruction === undefined ? '' : text(o.instruction), rotation: o.rotation === undefined ? 0 : number(o.rotation, 0, MAX_ROTATION) };
  });
  const byId = new Map(objects.map(o => [o.id, o]));
  if (byId.size !== objects.length) throw new ValidationError('Duplicate diagram IDs.');
  for (const o of objects) {
    const seen = new Set([o.id]); let parent = o.parentId;
    while (parent !== null) {
      const area = byId.get(parent);
      if (!area || area.type !== 'area' || seen.has(parent)) throw new ValidationError('Invalid or circular diagram area hierarchy.');
      seen.add(parent); parent = area.parentId;
    }
  }
  const connectors = body.connectors.map((value): NativeConnector => {
    const c = object(value);
    const sourceId = c.sourceId === null ? null : id(c.sourceId), targetId = c.targetId === null ? null : id(c.targetId);
    if ((sourceId !== null && !byId.has(sourceId)) || (targetId !== null && !byId.has(targetId))) throw new ValidationError('A connector endpoint is missing or is not a native shape.');
    if (!Array.isArray(c.points) || c.points.length < MIN_POINTS || c.points.length > MAX_POINTS) throw new ValidationError('Invalid connector route.');
    const connectorId = id(c.id);
    if (byId.has(connectorId)) throw new ValidationError('Duplicate diagram IDs.');
    return { id: connectorId, sourceId, targetId, points: c.points.map(point), route: oneOf(c.route, ['straight', 'orthogonal'] as const),
      arrows: oneOf(c.arrows, ['none', 'start', 'end', 'both'] as const), stroke: colour(c.stroke), strokeWidth: number(c.strokeWidth, 1, MAX_STROKE),
      dashed: bool(c.dashed), text: text(c.text), fontSize: number(c.fontSize, 1, MAX_FONT), label: point(c.label) };
  });
  if (new Set(connectors.map(c => c.id)).size !== connectors.length) throw new ValidationError('Duplicate connector IDs.');
  return { board, title, objects, connectors };
}

function createdId(response: Record<string, unknown>, array = false): string {
  const value: unknown = array ? (Array.isArray(response.value) && response.value.length === 1 ? response.value[0] : null) : response.value;
  const widget = objectResponse(value);
  if (typeof widget.id !== 'string' || !widget.id) throw new IntegrationError('mural', 'Mural did not return the created object ID.');
  return widget.id;
}
function objectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntegrationError('mural', 'Unexpected native object response.');
  return value as Record<string, unknown>;
}

export async function exportMuralDiagram(db: Pool, input: unknown): Promise<{ boardUrl: string; objects: number; connectors: number }> {
  // Validate the complete export before the first external write.
  const diagram = validateMuralDiagram(input);
  return withToken(db, async token => {
    const path = `/murals/${encodeURIComponent(diagram.board.id)}`;
    await apiJson(token, path);
    const ids = new Map<string, string>();
    const originals = new Map(diagram.objects.map(o => [o.id, o]));
    let writes = 0;
    try {
      const pending = [...diagram.objects];
      while (pending.length) {
        const index = pending.findIndex(o => o.parentId === null || ids.has(o.parentId));
        if (index < 0) throw new IntegrationError('mural', 'Could not resolve native area parents.');
        const o = pending.splice(index, 1)[0]!;
        const parent = o.parentId === null ? undefined : originals.get(o.parentId);
        const common = { x: o.x - (parent?.x ?? 0), y: o.y - (parent?.y ?? 0), width: o.width, height: o.height,
          title: o.text || diagram.title, instruction: html(o.instruction),
          ...(o.parentId === null ? {} : { parentId: ids.get(o.parentId) }) };
        let response: Record<string, unknown>;
        writes++;
        if (o.type === 'area') {
          response = await apiJson(token, `${path}/widgets/area`, { ...common, layout: 'free', showTitle: false,
            style: { backgroundColor: o.fill, borderColor: o.stroke, borderStyle: o.dotted ? 'dotted' : 'solid', borderWidth: o.strokeWidth, titleFontSize: o.fontSize } });
        } else if (o.type === 'shape') {
          response = await apiJson(token, `${path}/widgets/shape`, [{ ...common, rotation: o.rotation, shape: o.shape, text: o.text,
            style: { backgroundColor: o.fill, borderColor: o.stroke, borderStyle: o.dotted ? 'dotted' : 'solid', borderWidth: o.strokeWidth, fontColor: o.textColor } }]);
        } else if (o.type === 'textbox') {
          response = await apiJson(token, `${path}/widgets/textbox`, [{ ...common, rotation: o.rotation, text: `<span style="color: ${o.textColor.slice(0, RGB_HEX_LENGTH)}">${html(o.text)}</span>`,
            style: { backgroundColor: o.fill, font: 'proxima-nova', fontSize: o.fontSize, textAlign: o.align } }]);
        } else {
          const asset = objectResponse((await apiJson(token, `${path}/assets`, { fileExtension: 'png' })).value);
          const upload = muralUploadUrl(asset.url);
          if (typeof asset.name !== 'string' || !asset.name || o.image === null) throw new IntegrationError('mural', 'Missing native image asset.');
          const uploaded = await request(upload, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/png' }, body: new Uint8Array(o.image) });
          if (!uploaded.ok) throw new IntegrationError('mural', `Icon upload failed (HTTP ${uploaded.status}).`);
          response = await apiJson(token, `${path}/widgets/image`, { ...common, name: asset.name, caption: o.text, showCaption: Boolean(o.text), border: false });
        }
        ids.set(o.id, createdId(response, o.type === 'shape' || o.type === 'textbox'));
      }
      for (const c of diagram.connectors) {
        const points = [...c.points];
        let start = c.sourceId === null ? undefined : ids.get(c.sourceId), end = c.targetId === null ? undefined : ids.get(c.targetId);
        if (c.arrows === 'start') { points.reverse(); [start, end] = [end, start]; }
        const xs = points.map(p => p.x), ys = points.map(p => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        writes++;
        createdId(await apiJson(token, `${path}/widgets/arrow`, { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y),
          points: points.map(p => ({ x: p.x - x, y: p.y - y })), arrowType: c.route,
          tip: c.arrows === 'both' ? 'double' : c.arrows === 'none' ? 'no tip' : 'single',
          ...(start ? { startRefId: start } : {}), ...(end ? { endRefId: end } : {}),
          style: { strokeColor: c.stroke, strokeWidth: c.strokeWidth, strokeStyle: c.dashed ? 'dashed' : 'solid' },
          title: c.text,
          ...(c.text ? { label: { format: { color: c.stroke, fontFamily: 'proxima-nova', bold: false, italic: false, textAlign: 'center', fontSize: c.fontSize },
            labels: [{ x: c.label.x - x - LABEL_HALF_WIDTH, y: c.label.y - y - c.fontSize, width: LABEL_WIDTH, height: Math.max(LABEL_MIN_HEIGHT, c.fontSize * LABEL_LINE_HEIGHT), text: c.text }] } } : {}) }));
      }
    } catch (error) {
      throw new IntegrationError('mural', `${error instanceof Error ? error.message : 'Native export failed.'} ${writes} object creation attempt(s). Some objects may already exist; inspect the board before retrying. Nothing was automatically retried or deleted.`);
    }
    return { boardUrl: diagram.board.url, objects: diagram.objects.length, connectors: diagram.connectors.length };
  });
}
