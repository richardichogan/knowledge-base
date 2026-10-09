/**
 * services/diagramValidation.ts
 * Pure validation for diagram canvases (no database access):
 *  - validateDiagramDocument: strict shape/limits/reference checks for a saved document.
 *  - validateAssetUpload: PNG (signature, chunk structure, CRCs, dimensions) and
 *    SVG (parsed with fast-xml-parser, element/attribute allowlist).
 * Unsafe or malformed input is rejected with a ValidationError (HTTP 422), never
 * silently sanitised.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ValidationError } from '../types/errors.js';
import type {
  DiagramDocument, DiagramEdge, DiagramKind, DiagramNode, DiagramPoint, DiagramPort,
} from '../types/diagram.js';

export const DIAGRAM_LIMITS = {
  maxNodes: 1000,
  maxEdges: 2000,
  maxWaypointsPerEdge: 100,
  /** |x|, |y| of nodes and waypoints. */
  maxCoordinate: 1_000_000,
  minNodeSize: 1,
  maxNodeSize: 100_000,
  maxNodeLabelChars: 2000,
  maxEdgeLabelChars: 500,
  maxDescriptionChars: 10_000,
  minFontSize: 6,
  maxFontSize: 200,
  /** |x|, |y| of the viewport pan. */
  maxViewportOffset: 100_000_000,
  minZoom: 0.05,
  maxZoom: 10,
  maxRevision: 2_147_483_647,
  maxAssetBytes: 5 * 1024 * 1024,
  maxAssetsPerCanvas: 200,
  maxAssetNameChars: 200,
  maxPngDimension: 16_384,
  maxPngPixels: 40_000_000,
  maxSvgElements: 20_000,
  maxSvgDepth: 64,
} as const;

export const ASSET_CONTENT_TYPES = ['image/png', 'image/svg+xml'] as const;
export type AssetContentType = typeof ASSET_CONTENT_TYPES[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|none)$/i;
// Labels may contain line breaks and tabs, but no other control characters.
// eslint-disable-next-line no-control-regex
const LABEL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const NAME_CONTROL_RE = /[\u0000-\u001f\u007f]/;

const KINDS: readonly DiagramKind[] = ['process', 'decision', 'terminator', 'text', 'image', 'container', 'swimlane'];
const PARENT_KINDS: ReadonlySet<DiagramKind> = new Set<DiagramKind>(['container', 'swimlane']);
const PORTS: readonly DiagramPort[] = ['top', 'right', 'bottom', 'left'];
const ROUTES: readonly DiagramEdge['route'][] = ['straight', 'orthogonal'];
const ARROWS: readonly DiagramEdge['arrows'][] = ['none', 'end', 'both'];

const DOC_KEYS = ['version', 'nodes', 'edges', 'grid', 'viewport'] as const;
const VIEWPORT_KEYS = ['x', 'y', 'zoom'] as const;
const POINT_KEYS = ['x', 'y'] as const;
const NODE_KEYS = ['id', 'kind', 'label', 'x', 'y', 'width', 'height', 'parentId', 'fill', 'stroke', 'textColor', 'fontSize', 'assetId'] as const;
const EDGE_KEYS = ['id', 'sourceId', 'targetId', 'sourcePort', 'targetPort', 'route', 'waypoints', 'label', 'stroke', 'dashed', 'arrows'] as const;

// ─── Document ───────────────────────────────────────────────────────────────

function fail(path: string, reason: string): never {
  throw new ValidationError(`Invalid diagram: ${path} ${reason}`, { [path]: reason });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function exactObject(v: unknown, keys: readonly string[], path: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!isPlainObject(v)) fail(path, 'must be an object');
  const allowed = new Set([...keys, ...optional]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) fail(`${path}.${k}`, 'is not an allowed property');
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) fail(`${path}.${k}`, 'is required');
  return v;
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  if (v < min || v > max) fail(path, `must be between ${min} and ${max}`);
  return v === 0 ? 0 : v; // normalise -0
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') fail(path, 'must be a string');
  if (v.length > max) fail(path, `must be at most ${max} characters`);
  if (LABEL_CONTROL_RE.test(v)) fail(path, 'must not contain control characters');
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'must be a boolean');
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(path, `must be one of ${allowed.join(', ')}`);
  return v as T;
}

function uuid(v: unknown, path: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) fail(path, 'must be a UUID');
  return v;
}

function color(v: unknown, path: string): string {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) fail(path, 'must be a hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa), "transparent" or "none"');
  return v;
}

function array(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  if (v.length > max) fail(path, `must have at most ${max} items`);
  return v;
}

export function validateRevision(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > DIAGRAM_LIMITS.maxRevision) {
    fail('revision', 'must be a non-negative integer');
  }
  return v;
}

function validatePoint(v: unknown, path: string): DiagramPoint {
  const o = exactObject(v, POINT_KEYS, path);
  const c = DIAGRAM_LIMITS.maxCoordinate;
  return { x: num(o['x'], `${path}.x`, -c, c), y: num(o['y'], `${path}.y`, -c, c) };
}

function validateNode(v: unknown, path: string): DiagramNode {
  const o = exactObject(v, NODE_KEYS, path, ['description', 'textAlign', 'textVerticalAlign', 'strokeWidth', 'strokeStyle']);
  const c = DIAGRAM_LIMITS.maxCoordinate;
  const kind = oneOf(o['kind'], KINDS, `${path}.kind`);
  const assetId = o['assetId'] === null ? null : uuid(o['assetId'], `${path}.assetId`);
  if (assetId !== null && kind !== 'image') fail(`${path}.assetId`, 'is only allowed on image nodes');
  return {
    id: uuid(o['id'], `${path}.id`),
    kind,
    label: str(o['label'], `${path}.label`, DIAGRAM_LIMITS.maxNodeLabelChars),
    ...(o['description'] !== undefined ? { description: str(o['description'], `${path}.description`, DIAGRAM_LIMITS.maxDescriptionChars) } : {}),
    x: num(o['x'], `${path}.x`, -c, c),
    y: num(o['y'], `${path}.y`, -c, c),
    width: num(o['width'], `${path}.width`, DIAGRAM_LIMITS.minNodeSize, DIAGRAM_LIMITS.maxNodeSize),
    height: num(o['height'], `${path}.height`, DIAGRAM_LIMITS.minNodeSize, DIAGRAM_LIMITS.maxNodeSize),
    parentId: o['parentId'] === null ? null : uuid(o['parentId'], `${path}.parentId`),
    fill: color(o['fill'], `${path}.fill`),
    stroke: color(o['stroke'], `${path}.stroke`),
    ...(o['strokeWidth'] !== undefined ? { strokeWidth: num(o['strokeWidth'], `${path}.strokeWidth`, 0.5, 6) } : {}),
    ...(o['strokeStyle'] !== undefined ? { strokeStyle: oneOf(o['strokeStyle'], ['solid', 'dashed', 'dotted'] as const, `${path}.strokeStyle`) } : {}),
    textColor: color(o['textColor'], `${path}.textColor`),
    fontSize: num(o['fontSize'], `${path}.fontSize`, DIAGRAM_LIMITS.minFontSize, DIAGRAM_LIMITS.maxFontSize),
    ...(o['textAlign'] !== undefined ? { textAlign: oneOf(o['textAlign'], ['left', 'center', 'right'] as const, `${path}.textAlign`) } : {}),
    ...(o['textVerticalAlign'] !== undefined ? { textVerticalAlign: oneOf(o['textVerticalAlign'], ['top', 'middle', 'bottom'] as const, `${path}.textVerticalAlign`) } : {}),
    assetId,
  };
}

function validateEdge(v: unknown, path: string): DiagramEdge {
  const o = exactObject(v, EDGE_KEYS, path, ['description', 'strokeWidth']);
  const waypoints = array(o['waypoints'], `${path}.waypoints`, DIAGRAM_LIMITS.maxWaypointsPerEdge)
    .map((p, i) => validatePoint(p, `${path}.waypoints[${i}]`));
  return {
    id: uuid(o['id'], `${path}.id`),
    sourceId: uuid(o['sourceId'], `${path}.sourceId`),
    targetId: uuid(o['targetId'], `${path}.targetId`),
    sourcePort: oneOf(o['sourcePort'], PORTS, `${path}.sourcePort`),
    targetPort: oneOf(o['targetPort'], PORTS, `${path}.targetPort`),
    route: oneOf(o['route'], ROUTES, `${path}.route`),
    waypoints,
    label: str(o['label'], `${path}.label`, DIAGRAM_LIMITS.maxEdgeLabelChars),
    ...(o['description'] !== undefined ? { description: str(o['description'], `${path}.description`, DIAGRAM_LIMITS.maxDescriptionChars) } : {}),
    stroke: color(o['stroke'], `${path}.stroke`),
    ...(o['strokeWidth'] !== undefined ? { strokeWidth: num(o['strokeWidth'], `${path}.strokeWidth`, 0.5, 6) } : {}),
    dashed: bool(o['dashed'], `${path}.dashed`),
    arrows: oneOf(o['arrows'], ARROWS, `${path}.arrows`),
  };
}

/**
 * Validates a whole diagram document and returns a clean copy containing only
 * known properties. `knownAssetIds` are the assets uploaded to this canvas;
 * image nodes may only reference those.
 */
export function validateDiagramDocument(input: unknown, knownAssetIds: ReadonlySet<string>): DiagramDocument {
  const o = exactObject(input, DOC_KEYS, 'document');
  if (o['version'] !== 1) fail('document.version', 'must be 1');
  const nodes = array(o['nodes'], 'document.nodes', DIAGRAM_LIMITS.maxNodes).map((n, i) => validateNode(n, `document.nodes[${i}]`));
  const edges = array(o['edges'], 'document.edges', DIAGRAM_LIMITS.maxEdges).map((e, i) => validateEdge(e, `document.edges[${i}]`));
  const vp = exactObject(o['viewport'], VIEWPORT_KEYS, 'document.viewport');
  const off = DIAGRAM_LIMITS.maxViewportOffset;
  const viewport = {
    x: num(vp['x'], 'document.viewport.x', -off, off),
    y: num(vp['y'], 'document.viewport.y', -off, off),
    zoom: num(vp['zoom'], 'document.viewport.zoom', DIAGRAM_LIMITS.minZoom, DIAGRAM_LIMITS.maxZoom),
  };
  const grid = bool(o['grid'], 'document.grid');

  // Ids are unique across nodes and edges (case-insensitively); references match exactly.
  const seen = new Set<string>();
  const byId = new Map<string, DiagramNode>();
  nodes.forEach((n, i) => {
    const key = n.id.toLowerCase();
    if (seen.has(key)) fail(`document.nodes[${i}].id`, 'is a duplicate id');
    seen.add(key);
    byId.set(n.id, n);
  });
  edges.forEach((e, i) => {
    const key = e.id.toLowerCase();
    if (seen.has(key)) fail(`document.edges[${i}].id`, 'is a duplicate id');
    seen.add(key);
    if (!byId.has(e.sourceId)) fail(`document.edges[${i}].sourceId`, 'references a missing node');
    if (!byId.has(e.targetId)) fail(`document.edges[${i}].targetId`, 'references a missing node');
  });

  nodes.forEach((n, i) => {
    if (n.assetId !== null && !knownAssetIds.has(n.assetId)) fail(`document.nodes[${i}].assetId`, 'references a missing asset');
    if (n.parentId === null) return;
    if (n.parentId === n.id) fail(`document.nodes[${i}].parentId`, 'must not reference the node itself');
    const parent = byId.get(n.parentId);
    if (parent === undefined) fail(`document.nodes[${i}].parentId`, 'references a missing node');
    if (!PARENT_KINDS.has(parent.kind)) fail(`document.nodes[${i}].parentId`, 'must reference a container or swimlane');
  });

  // Parent chains must terminate (no cycles). Each node is resolved at most once.
  const state = new Map<string, 'visiting' | 'done'>();
  nodes.forEach((start, i) => {
    const chain: string[] = [];
    let cur: DiagramNode | undefined = start;
    while (cur !== undefined && state.get(cur.id) !== 'done') {
      if (state.get(cur.id) === 'visiting') fail(`document.nodes[${i}].parentId`, 'creates a parent cycle');
      state.set(cur.id, 'visiting');
      chain.push(cur.id);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    for (const id of chain) state.set(id, 'done');
  });

  return { version: 1, nodes, edges, grid, viewport };
}

// ─── Assets ─────────────────────────────────────────────────────────────────

function rejectFile(reason: string): never {
  throw new ValidationError(`Invalid image: ${reason}`, { file: reason });
}

export function normaliseContentType(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

export function validateAssetName(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('name query parameter is required', { name: 'required' });
  const name = v.trim();
  if (name === '' || name.length > DIAGRAM_LIMITS.maxAssetNameChars) {
    throw new ValidationError(`name must be 1-${DIAGRAM_LIMITS.maxAssetNameChars} characters`, { name: 'invalid length' });
  }
  if (NAME_CONTROL_RE.test(name)) throw new ValidationError('name must not contain control characters', { name: 'control characters' });
  return name;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_BIT_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** Validates the PNG container (signature, IHDR, every chunk CRC, IDAT, IEND, no trailing bytes). */
export function inspectPng(buf: Buffer): { width: number; height: number } {
  if (buf.length < PNG_SIGNATURE.length + 25 + 12 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) rejectFile('not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let first = true;
  for (;;) {
    if (offset + 12 > buf.length) rejectFile('truncated PNG chunk');
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) rejectFile('invalid PNG chunk type');
    const dataEnd = offset + 8 + length;
    if (length > 0x7fffffff || dataEnd + 4 > buf.length) rejectFile('truncated PNG chunk');
    if (crc32(buf, offset + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) rejectFile(`bad CRC in PNG ${type} chunk`);
    if (first) {
      if (type !== 'IHDR' || length !== 13) rejectFile('PNG must start with an IHDR chunk');
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
      const bitDepth = buf[offset + 16]!;
      const colorType = buf[offset + 17]!;
      if (width < 1 || height < 1 || width > DIAGRAM_LIMITS.maxPngDimension || height > DIAGRAM_LIMITS.maxPngDimension) {
        rejectFile(`PNG dimensions must be 1-${DIAGRAM_LIMITS.maxPngDimension} pixels`);
      }
      if (width * height > DIAGRAM_LIMITS.maxPngPixels) rejectFile(`PNG must have at most ${DIAGRAM_LIMITS.maxPngPixels} pixels`);
      if (!(PNG_BIT_DEPTHS[colorType] ?? []).includes(bitDepth)) rejectFile('invalid PNG colour type / bit depth');
      if (buf[offset + 18] !== 0 || buf[offset + 19] !== 0 || (buf[offset + 20] !== 0 && buf[offset + 20] !== 1)) {
        rejectFile('invalid PNG compression, filter or interlace method');
      }
      first = false;
    } else if (type === 'IHDR') {
      rejectFile('duplicate PNG IHDR chunk');
    }
    if (type === 'IDAT') sawIdat = true;
    offset = dataEnd + 4;
    if (type === 'IEND') {
      if (length !== 0) rejectFile('invalid PNG IEND chunk');
      if (offset !== buf.length) rejectFile('unexpected data after PNG IEND');
      break;
    }
  }
  if (!sawIdat) rejectFile('PNG has no image data');
  return { width, height };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Static, non-scriptable, non-fetching SVG — enough for official Azure / Power
// Platform / Fabric icon exports (gradients, masks, clip paths, filters, <style>
// classes, url(#local) paint). Anything else (script, foreignObject, a, image,
// animate/set, feImage, iframe …) is rejected.
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'metadata', 'symbol', 'use', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'marker', 'pattern',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feFlood', 'feComposite',
  'feMerge', 'feMergeNode', 'feDropShadow', 'feMorphology', 'feComponentTransfer', 'feFuncR', 'feFuncG',
  'feFuncB', 'feFuncA', 'feTurbulence', 'feDisplacementMap', 'feConvolveMatrix', 'feTile',
  'feDiffuseLighting', 'feSpecularLighting', 'feDistantLight', 'fePointLight', 'feSpotLight',
]);
const SVG_FORBIDDEN_ATTRS: ReadonlySet<string> = new Set(['src', 'action', 'formaction', 'background', 'lowsrc', 'dynsrc', 'srcset']);
const ATTR_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const NCNAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// Local fragment ids; Azure icon ids are often UUIDs, which may start with a digit.
const LOCAL_REF_RE = /^#[A-Za-z0-9_][\w.:-]*$/;
const LOCAL_URL_RE = /url\((['"]?)#[a-z0-9_][\w.:-]*\1\)/g;
// Editor bookkeeping namespaces (Inkscape, Illustrator, Sketch, Serif, RDF metadata).
// Their elements/attributes are ignored by renderers; they may be declared, nothing else may.
const INERT_NAMESPACES: ReadonlySet<string> = new Set([
  'http://www.inkscape.org/namespaces/inkscape',
  'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://purl.org/dc/elements/1.1/',
  'http://creativecommons.org/ns#',
  'http://web.resource.org/cc/',
  'http://www.bohemiancoding.com/sketch/ns',
  'http://www.serif.com/',
  'http://ns.adobe.com/AdobeIllustrator/10.0/',
  'http://ns.adobe.com/AdobeSVGViewerExtensions/3.0/',
  'http://ns.adobe.com/Extensibility/1.0/',
  'http://ns.adobe.com/Flows/1.0/',
  'http://ns.adobe.com/GenericCustomNamespace/1.0/',
  'http://ns.adobe.com/Graphs/1.0/',
  'http://ns.adobe.com/ImageReplacement/1.0/',
  'http://ns.adobe.com/SaveForWeb/1.0/',
  'http://ns.adobe.com/Variables/1.0/',
  'http://ns.adobe.com/XPath/1.0/',
]);
const CSS_FORBIDDEN = ['url(', '@import', '@font-face', '@namespace', 'expression(', 'javascript:', 'vbscript:', 'data:',
  '-moz-binding', 'behavior:', 'image(', 'image-set(', 'cross-fade(', 'element(', 'src(', 'paint('];

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(v: string): string {
  return v.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (_m, ref: string) => {
    if (ref.startsWith('#')) {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff) rejectFile('SVG contains an invalid character reference');
      return String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES[ref];
    if (named === undefined) rejectFile('SVG must not use entities');
    return named;
  });
}

/** Rejects any CSS / attribute value that could fetch a resource or run code. Only url(#local) is allowed. */
function checkSvgValue(raw: string, where: string): void {
  const value = decodeXml(raw);
  if (value.includes('\\')) rejectFile(`SVG ${where} must not contain escapes`);
  // Browsers ignore whitespace/control characters inside these tokens, so compare without them.
  // eslint-disable-next-line no-control-regex
  const compact = value.toLowerCase().replace(/[\s\u0000-\u001f\u007f]+/g, '').replace(/\/\*.*?\*\//g, '');
  const withoutLocal = compact.replace(LOCAL_URL_RE, '');
  for (const token of CSS_FORBIDDEN) {
    if (withoutLocal.includes(token)) rejectFile(`SVG ${where} contains a forbidden reference (${token})`);
  }
}

type XmlEntry = Record<string, unknown>;

const svgParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: false,
  processEntities: false,
  htmlEntities: false,
  commentPropName: '#comment',
  cdataPropName: '#cdata',
  ignoreDeclaration: false,
  ignorePiTags: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function entryName(entry: XmlEntry): string {
  const keys = Object.keys(entry).filter((k) => k !== ':@');
  if (keys.length !== 1) rejectFile('SVG could not be parsed safely');
  return keys[0]!;
}

function entryAttrs(entry: XmlEntry): Array<[string, unknown]> {
  const attrs = entry[':@'];
  if (attrs === undefined) return [];
  if (!isPlainObject(attrs)) rejectFile('SVG could not be parsed safely');
  return Object.entries(attrs);
}

function entryChildren(entry: XmlEntry, name: string): XmlEntry[] {
  const children = entry[name];
  if (!Array.isArray(children)) rejectFile('SVG could not be parsed safely');
  return children as XmlEntry[];
}

type PrefixKind = 'xlink' | 'svg' | 'inert';

/**
 * Collects every xmlns:prefix declaration in the document. A prefix may only be
 * bound to the xlink namespace (as "xlink"), the SVG namespace, or an inert
 * editor namespace, and never to two different namespaces — so a prefixed name
 * can never smuggle in XHTML, XML Events or an aliased xlink:href.
 */
function collectPrefixes(entries: XmlEntry[], out: Map<string, PrefixKind>): void {
  for (const entry of entries) {
    const name = entryName(entry);
    if (name === '#text' || name === '#comment' || name === '#cdata' || name.startsWith('?')) continue;
    for (const [attr, value] of entryAttrs(entry)) {
      if (!attr.startsWith('xmlns:')) continue;
      const prefix = attr.slice('xmlns:'.length);
      if (!NCNAME_RE.test(prefix) || typeof value !== 'string') rejectFile(`SVG namespace declaration ${attr} is invalid`);
      const uri = decodeXml(value).trim();
      let kind: PrefixKind;
      if (prefix === 'xlink' && uri === XLINK_NS) kind = 'xlink';
      else if (prefix !== 'xlink' && uri === SVG_NS) kind = 'svg';
      else if (prefix !== 'xlink' && INERT_NAMESPACES.has(uri)) kind = 'inert';
      else rejectFile(`SVG namespace ${attr}="${uri}" is not allowed`);
      const prev = out.get(prefix);
      if (prev !== undefined && prev !== kind) rejectFile(`SVG namespace prefix ${prefix} is declared twice`);
      out.set(prefix, kind);
    }
    collectPrefixes(entryChildren(entry, name), out);
  }
}

/**
 * Counts start tags with a sequential scan (skipping comments, CDATA sections and
 * processing instructions exactly as an XML parser does), so it can be compared
 * with the number of elements actually validated.
 */
function countStartTags(text: string): number {
  let count = 0;
  let i = text.indexOf('<');
  while (i !== -1) {
    let end: number;
    if (text.startsWith('<!--', i)) end = text.indexOf('-->', i + 4);
    else if (text.startsWith('<![CDATA[', i)) end = text.indexOf(']]>', i + 9);
    else if (text.startsWith('<?', i)) end = text.indexOf('?>', i + 2);
    else {
      if (/[A-Za-z_:]/.test(text.charAt(i + 1))) count++;
      end = i + 1;
    }
    if (end === -1) rejectFile('SVG is not well-formed XML');
    i = text.indexOf('<', end);
  }
  return count;
}

/**
 * Validates an SVG upload: UTF-8, well-formed XML (fast-xml-parser), single
 * <svg> root in the SVG namespace, allowlisted elements and attributes, no
 * DTD/entities/CDATA/processing instructions, no event handlers, and no
 * references outside the document (href and url() must be local "#id").
 */
export function validateSvg(buf: Buffer): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    rejectFile('SVG must be UTF-8 text');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) rejectFile('SVG must not contain NUL characters');
  const lower = text.toLowerCase();
  if (lower.includes('<!doctype')) rejectFile('SVG must not contain a DOCTYPE');
  if (lower.includes('<!entity')) rejectFile('SVG must not declare entities');
  if (XMLValidator.validate(text, { allowBooleanAttributes: false }) !== true) rejectFile('SVG is not well-formed XML');

  let doc: unknown;
  try {
    doc = svgParser.parse(text);
  } catch {
    rejectFile('SVG is not well-formed XML');
  }
  if (!Array.isArray(doc)) rejectFile('SVG could not be parsed safely');
  const prefixes = new Map<string, PrefixKind>();
  collectPrefixes(doc as XmlEntry[], prefixes);

  let elements = 0;
  const walk = (entry: XmlEntry, name: string, depth: number, isRoot: boolean): void => {
    if (depth > DIAGRAM_LIMITS.maxSvgDepth) rejectFile('SVG is nested too deeply');
    if (++elements > DIAGRAM_LIMITS.maxSvgElements) rejectFile('SVG has too many elements');
    // Element: an allowlisted SVG element (optionally svg:-prefixed), or an inert editor element
    // (sodipodi:namedview, rdf:RDF …) whose children are still validated with the same rules.
    const colon = name.indexOf(':');
    const elPrefix = colon === -1 ? null : name.slice(0, colon);
    const elLocal = colon === -1 ? name : name.slice(colon + 1);
    const elKind = elPrefix === null ? 'svg' : prefixes.get(elPrefix);
    const inertElement = elKind === 'inert';
    if (!inertElement && (elKind !== 'svg' || !SVG_ELEMENTS.has(elLocal))) rejectFile(`SVG element <${name}> is not allowed`);
    if (inertElement && !NCNAME_RE.test(elLocal)) rejectFile(`SVG element <${name}> is not allowed`);
    for (const [attr, value] of entryAttrs(entry)) {
      if (typeof value !== 'string') rejectFile(`SVG attribute ${attr} is invalid`);
      const parts = attr.split(':');
      if (parts.length > 2) rejectFile(`SVG attribute ${attr} is not allowed`);
      const prefix = parts.length === 2 ? parts[0]! : null;
      const local = parts.length === 2 ? parts[1]! : attr;
      const localLower = local.toLowerCase();
      if (!(prefix === null ? ATTR_NAME_RE : NCNAME_RE).test(local)) rejectFile(`SVG attribute ${attr} is not allowed`);
      if (localLower.startsWith('on')) rejectFile(`SVG event handler attribute ${attr} is not allowed`);
      if (SVG_FORBIDDEN_ATTRS.has(localLower)) rejectFile(`SVG attribute ${attr} is not allowed`);
      const decoded = decodeXml(value);
      if (prefix === null) {
        if (attr === 'xmlns' && decoded !== SVG_NS) rejectFile('SVG must only use the SVG namespace');
      } else if (prefix === 'xmlns') {
        // Already validated by collectPrefixes.
      } else if (prefix === 'xml') {
        if (local !== 'space' && local !== 'lang') rejectFile(`SVG attribute ${attr} is not allowed`);
      } else {
        const kind = prefixes.get(prefix);
        if (kind === 'xlink') {
          if (local !== 'href' && local !== 'title') rejectFile(`SVG attribute ${attr} is not allowed`);
        } else if (kind !== 'inert' || localLower === 'href') {
          rejectFile(`SVG attribute ${attr} is not allowed`);
        }
      }
      const isLink = localLower === 'href' && (prefix === null || prefixes.get(prefix) === 'xlink');
      if (isLink && !LOCAL_REF_RE.test(decoded.trim())) rejectFile('SVG must not reference external resources');
      checkSvgValue(value, `attribute ${attr}`);
    }
    if (isRoot && (name !== 'svg' || entryAttrs(entry).find(([k]) => k === 'xmlns')?.[1] !== SVG_NS)) {
      rejectFile('SVG root must declare the SVG namespace');
    }
    for (const child of entryChildren(entry, name)) {
      const childName = entryName(child);
      if (childName === '#text') {
        // Text content may only use the predefined XML entities / character references.
        if (elLocal === 'style' && !inertElement) checkSvgValue(String(child['#text']), 'style');
        else decodeXml(String(child['#text']));
        continue;
      }
      if (childName === '#comment') continue;
      if (childName === '#cdata') {
        // Illustrator wraps <style> in CDATA; allowed there only, with the same CSS checks.
        if (elLocal !== 'style' || inertElement) rejectFile('SVG must only use CDATA inside <style>');
        const parts = entryChildren(child, '#cdata');
        for (const part of parts) {
          if (entryName(part) !== '#text') rejectFile('SVG could not be parsed safely');
          checkSvgValue(String(part['#text']), 'style');
        }
        continue;
      }
      if (childName.startsWith('?') || childName.startsWith('!')) rejectFile('SVG must not contain processing instructions');
      walk(child, childName, depth + 1, false);
    }
  };

  let roots = 0;
  (doc as XmlEntry[]).forEach((entry, index) => {
    const name = entryName(entry);
    if (name === '#comment') return;
    if (name === '#text') {
      if (String(entry['#text']).trim() !== '') rejectFile('SVG has text outside the root element');
      return;
    }
    if (name === '?xml') {
      if (index !== 0) rejectFile('SVG XML declaration must come first');
      return;
    }
    if (name.startsWith('?') || name.startsWith('!')) rejectFile('SVG must not contain processing instructions');
    if (name !== 'svg') rejectFile('SVG root element must be <svg>');
    roots++;
    walk(entry, name, 0, true);
  });
  if (roots !== 1) rejectFile('SVG must have exactly one <svg> root element');

  // Cross-check: every start tag in the source must have been walked, so the
  // parser cannot have silently dropped an element (e.g. a "__proto__" tag).
  if (countStartTags(text) !== elements) rejectFile('SVG could not be parsed safely');
}

/** Validates an uploaded asset's declared type against its bytes. */
export function validateAssetUpload(buf: unknown, contentTypeHeader: string | undefined): {
  contentType: AssetContentType; width: number | null; height: number | null;
} {
  const contentType = normaliseContentType(contentTypeHeader);
  if (!(ASSET_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw new ValidationError('Content-Type must be image/png or image/svg+xml', { contentType: 'unsupported' });
  }
  if (!Buffer.isBuffer(buf) || buf.length === 0) rejectFile('request body must be the raw image bytes');
  if (buf.length > DIAGRAM_LIMITS.maxAssetBytes) rejectFile(`image must be at most ${DIAGRAM_LIMITS.maxAssetBytes} bytes`);
  if (contentType === 'image/png') {
    const { width, height } = inspectPng(buf);
    return { contentType, width, height };
  }
  validateSvg(buf);
  return { contentType: 'image/svg+xml', width: null, height: null };
}
