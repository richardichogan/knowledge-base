import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import {
  DIAGRAM_LIMITS, validateDiagramDocument, validateRevision, validateSvg, inspectPng, validateAssetUpload, validateAssetName,
} from '../src/services/diagramValidation.js';
import { saveDiagram } from '../src/services/diagramService.js';
import { cardSummaryBlocks, mapMarkdown, mapOutline, type CanvasFull } from '../src/services/canvasService.js';
import { buildCanvasContext } from '../src/services/canvasContent.js';
import { suggestionsFor } from '../src/services/mapSuggestions.js';
import { resolveMapChanges } from '../src/ai/mapEdits.js';
import { emptyDiagram, type DiagramDocument, type DiagramEdge, type DiagramNode } from '../src/types/diagram.js';
import { ConflictError, ValidationError } from '../src/types/errors.js';

const NONE = new Set<string>();

function node(over: Partial<DiagramNode> = {}): DiagramNode {
  return {
    id: randomUUID(), kind: 'process', label: 'Step', x: 0, y: 0, width: 120, height: 60, parentId: null,
    fill: '#ffffff', stroke: '#333333', textColor: '#111111', fontSize: 14, assetId: null, ...over,
  };
}
function edge(sourceId: string, targetId: string, over: Partial<DiagramEdge> = {}): DiagramEdge {
  return {
    id: randomUUID(), sourceId, targetId, sourcePort: 'right', targetPort: 'left', route: 'orthogonal',
    waypoints: [{ x: 10, y: 20 }], label: '', stroke: '#333333', dashed: false, arrows: 'end', ...over,
  };
}
function doc(nodes: DiagramNode[], edges: DiagramEdge[] = []): DiagramDocument {
  return { ...emptyDiagram(), nodes, edges };
}
/** Asserts a 422 whose field path matches. */
function rejects(fn: () => unknown, field: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.ok(Object.keys(err.fields).some((k) => field.test(k)), `fields ${JSON.stringify(err.fields)} !~ ${String(field)}`);
    return true;
  });
}

// ─── Document validation ─────────────────────────────────────────────────────

test('accepts a valid document and returns a clean copy', () => {
  const lane = node({ kind: 'swimlane', width: 800, height: 400 });
  const box = node({ kind: 'container', parentId: lane.id });
  const a = node({ parentId: box.id });
  const b = node({ kind: 'decision' });
  const assetId = randomUUID();
  const img = node({ kind: 'image', assetId });
  const input = doc([lane, box, a, b, img], [edge(a.id, b.id, { label: 'yes' })]);
  const out = validateDiagramDocument(JSON.parse(JSON.stringify(input)), new Set([assetId]));
  assert.deepEqual(out, input);
  assert.deepEqual(validateDiagramDocument(emptyDiagram(), NONE), emptyDiagram());
});

test('document artefacts round-trip with styling and attached connectors', () => {
  const artefact = node({ kind: 'document', label: 'Specification', strokeWidth: 3, strokeStyle: 'dotted',
    fill: '#1c2d4a', textAlign: 'left', textVerticalAlign: 'bottom' });
  const process = node({ x: 200 });
  const input = doc([artefact, process], [edge(artefact.id, process.id)]);
  assert.deepEqual(validateDiagramDocument(input, NONE), input);
});

test('rejects unknown keys at every level and a wrong version', () => {
  const a = node();
  rejects(() => validateDiagramDocument({ ...doc([a]), script: 'x' }, NONE), /^document\.script$/);
  rejects(() => validateDiagramDocument(doc([{ ...a, onclick: 'alert(1)' } as DiagramNode]), NONE), /nodes\[0\]\.onclick/);
  rejects(() => validateDiagramDocument({ ...doc([a]), viewport: { x: 0, y: 0, zoom: 1, href: 'x' } }, NONE), /viewport\.href/);
  rejects(() => validateDiagramDocument({ ...doc([a]), version: 2 }, NONE), /version/);
  rejects(() => validateDiagramDocument(doc([{ ...a, kind: 'html' as 'process' }]), NONE), /kind/);
  rejects(() => validateDiagramDocument(JSON.parse(`{"version":1,"nodes":[],"edges":[],"grid":true,"viewport":{"x":0,"y":0,"zoom":1},"__proto__":{"x":1}}`), NONE), /__proto__/);
});

test('text alignment round-trips and rejects unsupported values', () => {
  for (const textAlign of ['left', 'center', 'right'] as const) {
    for (const textVerticalAlign of ['top', 'middle', 'bottom'] as const) {
      const input = doc([node({ textAlign, textVerticalAlign })]);
      assert.deepEqual(validateDiagramDocument(input, NONE), input);
    }
  }
  rejects(() => validateDiagramDocument(doc([{ ...node(), textAlign: 'justify' } as unknown as DiagramNode]), NONE), /textAlign/);
  rejects(() => validateDiagramDocument(doc([{ ...node(), textVerticalAlign: 'baseline' } as unknown as DiagramNode]), NONE), /textVerticalAlign/);
});

test('shape and connector thickness round-trip with bounded finite values', () => {
  const a = node({ strokeWidth: 0.5 });
  const b = node({ strokeWidth: 6 });
  const input = doc([a, b], [edge(a.id, b.id, { strokeWidth: 4 })]);
  assert.deepEqual(validateDiagramDocument(input, NONE), input);
  for (const strokeWidth of [0, 6.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    rejects(() => validateDiagramDocument(doc([node({ strokeWidth })]), NONE), /strokeWidth/);
    rejects(() => validateDiagramDocument(doc([a, b], [edge(a.id, b.id, { strokeWidth })]), NONE), /strokeWidth/);
  }
});

test('shape border styles and colours round-trip without changing legacy defaults', () => {
  for (const strokeStyle of ['solid', 'dashed', 'dotted'] as const) {
    const input = doc([node({ strokeStyle, stroke: '#da1e28', strokeWidth: 3 })]);
    assert.deepEqual(validateDiagramDocument(input, NONE), input);
  }
  const legacy = doc([node()]);
  assert.deepEqual(validateDiagramDocument(legacy, NONE), legacy);
  const borderless = doc([node({ stroke: 'none', strokeStyle: 'dotted' })]);
  assert.deepEqual(validateDiagramDocument(borderless, NONE), borderless);
  for (const strokeStyle of ['double', '', 42, null]) {
    rejects(() => validateDiagramDocument({ ...legacy, nodes: [{ ...legacy.nodes[0], strokeStyle }] }, NONE), /strokeStyle/);
  }
});

test('optional item descriptions preserve legacy documents and round-trip shape and connector details', () => {
  const a = node({ description: 'Inputs, owner and expected output\nSecond line' });
  const b = node();
  const connection = edge(a.id, b.id, { description: 'Transfers the approved request.' });
  const input = doc([a, b], [connection]);
  assert.deepEqual(validateDiagramDocument(input, NONE), input);
  rejects(() => validateDiagramDocument(doc([{ ...a, description: 42 } as unknown as DiagramNode]), NONE), /description/);
  rejects(() => validateDiagramDocument(doc([a, b], [{ ...connection, description: 'x'.repeat(10001) }]), NONE), /description/);
  rejects(() => validateDiagramDocument(doc([{ ...a, description: 'bad\u0000text' }]), NONE), /description/);
});

test('rejects non-finite, huge or out-of-range geometry and bad styles', () => {
  rejects(() => validateDiagramDocument(doc([node({ x: Number.NaN })]), NONE), /nodes\[0\]\.x/);
  rejects(() => validateDiagramDocument(doc([node({ y: Number.POSITIVE_INFINITY })]), NONE), /nodes\[0\]\.y/);
  rejects(() => validateDiagramDocument(doc([node({ x: 1e300 })]), NONE), /nodes\[0\]\.x/);
  rejects(() => validateDiagramDocument(doc([node({ width: 0 })]), NONE), /width/);
  rejects(() => validateDiagramDocument(doc([node({ height: DIAGRAM_LIMITS.maxNodeSize + 1 })]), NONE), /height/);
  rejects(() => validateDiagramDocument(doc([node({ fontSize: 1000 })]), NONE), /fontSize/);
  rejects(() => validateDiagramDocument(doc([node({ fill: 'url(javascript:alert(1))' })]), NONE), /fill/);
  rejects(() => validateDiagramDocument(doc([node({ stroke: 'red; background:url(x)' })]), NONE), /stroke/);
  rejects(() => validateDiagramDocument(doc([node({ label: 'x'.repeat(DIAGRAM_LIMITS.maxNodeLabelChars + 1) })]), NONE), /label/);
  rejects(() => validateDiagramDocument({ ...emptyDiagram(), viewport: { x: 0, y: 0, zoom: 0 } }, NONE), /zoom/);
  rejects(() => validateDiagramDocument(doc([node({ x: '5' as unknown as number })]), NONE), /nodes\[0\]\.x/);
});

test('rejects non-UUID and duplicate ids', () => {
  rejects(() => validateDiagramDocument(doc([node({ id: 'n1' })]), NONE), /nodes\[0\]\.id/);
  const a = node();
  rejects(() => validateDiagramDocument(doc([a, node({ id: a.id })]), NONE), /nodes\[1\]\.id/);
  const b = node();
  rejects(() => validateDiagramDocument(doc([a, b], [edge(a.id, b.id, { id: a.id })]), NONE), /edges\[0\]\.id/);
});

test('rejects missing edge, parent and asset references', () => {
  const a = node();
  rejects(() => validateDiagramDocument(doc([a], [edge(a.id, randomUUID())]), NONE), /edges\[0\]\.targetId/);
  rejects(() => validateDiagramDocument(doc([a], [edge(randomUUID(), a.id)]), NONE), /edges\[0\]\.sourceId/);
  rejects(() => validateDiagramDocument(doc([node({ parentId: randomUUID() })]), NONE), /parentId/);
  rejects(() => validateDiagramDocument(doc([node({ kind: 'image', assetId: randomUUID() })]), NONE), /assetId/);
  const assetId = randomUUID();
  rejects(() => validateDiagramDocument(doc([node({ kind: 'process', assetId })]), new Set([assetId])), /assetId/);
});

test('rejects parent cycles, self-parenting and non-container parents', () => {
  const c1 = node({ kind: 'container' });
  const c2 = node({ kind: 'swimlane', parentId: c1.id });
  c1.parentId = c2.id;
  rejects(() => validateDiagramDocument(doc([c1, c2]), NONE), /parentId/);
  const self = node({ kind: 'container' });
  self.parentId = self.id;
  rejects(() => validateDiagramDocument(doc([self]), NONE), /parentId/);
  const p = node({ kind: 'process' });
  rejects(() => validateDiagramDocument(doc([p, node({ parentId: p.id })]), NONE), /parentId/);
  // A longer cycle hanging off a valid chain.
  const x = node({ kind: 'container' }); const y = node({ kind: 'container', parentId: x.id }); const z = node({ kind: 'container', parentId: y.id });
  x.parentId = z.id;
  rejects(() => validateDiagramDocument(doc([node({ parentId: z.id }), x, y, z]), NONE), /parentId/);
});

test('enforces node, edge and waypoint caps', () => {
  const nodes = Array.from({ length: DIAGRAM_LIMITS.maxNodes + 1 }, () => node());
  rejects(() => validateDiagramDocument(doc(nodes), NONE), /^document\.nodes$/);
  const a = node(); const b = node();
  const edges = Array.from({ length: DIAGRAM_LIMITS.maxEdges + 1 }, () => edge(a.id, b.id));
  rejects(() => validateDiagramDocument(doc([a, b], edges), NONE), /^document\.edges$/);
  const waypoints = Array.from({ length: DIAGRAM_LIMITS.maxWaypointsPerEdge + 1 }, (_, i) => ({ x: i, y: i }));
  rejects(() => validateDiagramDocument(doc([a, b], [edge(a.id, b.id, { waypoints })]), NONE), /waypoints/);
  rejects(() => validateDiagramDocument(doc([a, b], [edge(a.id, b.id, { waypoints: [{ x: 0, y: Number.NaN }] })]), NONE), /waypoints\[0\]\.y/);
  // Exactly at the limits is fine.
  assert.equal(validateDiagramDocument(doc(nodes.slice(0, DIAGRAM_LIMITS.maxNodes)), NONE).nodes.length, DIAGRAM_LIMITS.maxNodes);
});

test('validates revisions', () => {
  assert.equal(validateRevision(0), 0);
  assert.equal(validateRevision(42), 42);
  for (const bad of [-1, 1.5, '3', null, undefined, Number.NaN, 2 ** 31]) rejects(() => validateRevision(bad), /revision/);
});

// ─── SVG assets ──────────────────────────────────────────────────────────────

const svg = (body: string, attrs = ''): Buffer =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${body}</svg>`, 'utf8');

test('accepts a plain SVG with local references and safe styles', () => {
  validateSvg(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">
  <!-- a comment -->
  <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>
  <style>.a { fill: url(#g); stroke: #000 }</style>
  <rect class="a" width="10" height="10" fill="url(#g)"/>
  <use xlink:href="#g"/><text x="1" y="9">Hi &amp; bye</text>
</svg>`));
  assert.deepEqual(validateAssetUpload(svg('<circle r="4"/>'), 'image/svg+xml; charset=utf-8'), { contentType: 'image/svg+xml', width: null, height: null });
});

test('accepts official Azure / Power Platform / Fabric style icon SVGs', () => {
  // Azure Architecture Icons: UUID-style gradient ids, gradientUnits/Transform, stop style, url(#…) fill.
  validateSvg(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
  <defs>
    <linearGradient id="b05ecef1-bdba-47cb-a2a6-665a5bf9ae79" x1="9" y1="19.049" x2="9" y2="1.048" gradientUnits="userSpaceOnUse">
      <stop offset="0.2" stop-color="#0078d4"/><stop offset="0.287" stop-color="#1380da"/><stop offset="1" stop-color="#5ea0ef"/>
    </linearGradient>
    <radialGradient id="r" cx="9" cy="9" r="8" gradientTransform="matrix(1 0 0 0.5 0 4.5)" gradientUnits="userSpaceOnUse">
      <stop offset="0" style="stop-color:#fff;stop-opacity:1"/><stop offset="1" style="stop-color:#000;stop-opacity:0"/>
    </radialGradient>
  </defs>
  <title>Icon-web-41</title>
  <g id="a0a1c8b4-3d2c-4f71-bb3c-0c8f4c7f0b1e" data-name="fluent-icons">
    <path d="M17.5,10.5a2.5,2.5,0,0,1-2.5,2.5H3a3,3,0,0,1,0-6Z" fill="url(#b05ecef1-bdba-47cb-a2a6-665a5bf9ae79)"/>
    <circle cx="9" cy="9" r="4" style="fill:url('#r');opacity:0.6"/>
  </g>
</svg>`));
  // Illustrator / Power Platform export: CDATA <style> with classes, xlink gradient inheritance,
  // clip paths, masks, filters, xml:space and Illustrator namespaces.
  validateSvg(Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 24.0.0, SVG Export Plug-In -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0px" y="0px" viewBox="0 0 96 96" xml:space="preserve">
<style type="text/css"><![CDATA[
  .st0{fill:url(#SVGID_1_);}
  .st1{clip-path:url(#c);fill:url("#SVGID_2_");}
  .st2{mask:url(#m);filter:url(#f);opacity:0.25;}
]]></style>
<defs>
  <linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="96" y2="96"><stop offset="0" style="stop-color:#0B53CE"/><stop offset="1" style="stop-color:#7252AA"/></linearGradient>
  <linearGradient id="SVGID_2_" xlink:href="#SVGID_1_" gradientTransform="rotate(45)"/>
  <clipPath id="c"><rect width="96" height="96" rx="8"/></clipPath>
  <mask id="m" maskUnits="userSpaceOnUse"><rect width="96" height="96" fill="#fff"/></mask>
  <filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2"/><feOffset dy="1"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.3 0"/></filter>
</defs>
<g i:extraneous="self"><path class="st0" d="M0 0h96v96H0z"/><path class="st1" d="M8 8h80v80H8z"/><path class="st2" d="M0 0h10v10z"/></g>
</svg>`));
  // Inkscape export (Fabric icons are sometimes re-saved): sodipodi/inkscape metadata, svg: prefix.
  validateSvg(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"
  xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
  viewBox="0 0 10 10" sodipodi:docname="fabric.svg" inkscape:version="1.3">
  <sodipodi:namedview id="nv" pagecolor="#ffffff" inkscape:zoom="1"/>
  <metadata id="md"/>
  <svg:g inkscape:label="Layer 1" inkscape:groupmode="layer"><svg:rect width="10" height="10" fill="#117865"/></svg:g>
</svg>`));
});

const ICON_DIR = new URL('../../knowledge-hub-web/public/diagram-icons/', import.meta.url);

test('accepts every bundled official icon SVG unchanged', { skip: !existsSync(ICON_DIR) }, () => {
  const files = readdirSync(ICON_DIR).filter((f) => f.toLowerCase().endsWith('.svg'));
  assert.ok(files.length > 0, 'expected bundled icons');
  const rejected: string[] = [];
  for (const f of files) {
    try {
      // Same entry point the POST /api/canvases/:id/assets route uses.
      const result = validateAssetUpload(readFileSync(new URL(f, ICON_DIR)), 'image/svg+xml');
      assert.equal(result.contentType, 'image/svg+xml');
      validateAssetName(f);
    } catch (e) { rejected.push(`${f}: ${(e as Error).message}`); }
  }
  assert.deepEqual(rejected, []);
  // Every element the curated pack relies on is allowlisted (no <use>/<image>/external refs needed).
  const tags = new Set<string>();
  for (const f of files) for (const m of readFileSync(new URL(f, ICON_DIR), 'utf8').matchAll(/<([A-Za-z][\w:.-]*)/g)) tags.add(m[1]!);
  for (const t of ['circle', 'clipPath', 'defs', 'feBlend', 'feColorMatrix', 'feFlood', 'feGaussianBlur', 'feOffset', 'filter',
    'g', 'linearGradient', 'mask', 'path', 'polygon', 'radialGradient', 'rect', 'stop', 'svg', 'title']) {
    assert.ok(tags.has(t), `bundled icons are expected to use <${t}>`);
  }
});

test('rejects malicious SVGs instead of sanitising them', () => {
  const malicious: Record<string, Buffer> = {
    script: svg('<script>alert(1)</script>'),
    scriptCdata: svg('<script><![CDATA[alert(1)]]></script>'),
    onload: svg('<rect/>', ' onload="alert(1)"'),
    onEventUpper: svg('<rect ONCLICK="alert(1)"/>'),
    foreignObject: svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
    externalHref: svg('<use href="https://evil.example/x.svg#a"/>'),
    externalXlink: svg('<a xlink:href="javascript:alert(1)"><rect/></a>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'),
    image: svg('<image href="data:image/png;base64,AAAA"/>'),
    doctype: Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'),
    xxe: Buffer.from('<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg xmlns="http://www.w3.org/2000/svg"/>'),
    unknownEntity: svg('<text>&x;</text>'),
    styleUrl: svg('<style>rect { fill: url(https://evil.example/a) }</style>'),
    styleImport: svg('<style>@import "https://evil.example/a.css";</style>'),
    styleEscape: svg('<style>rect { background: \\75 rl(https://evil.example) }</style>'),
    attrStyleUrl: svg('<rect style="fill:url(http://evil.example/a)"/>'),
    entityEncodedHref: svg('<use href="&#106;avascript:alert(1)"/>'),
    stylesheetPi: Buffer.from('<?xml-stylesheet href="https://evil.example/a.css"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    protoWrapper: svg('<__proto__><script>alert(1)</script></__proto__>'),
    wrongNamespace: Buffer.from('<svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg>'),
    notSvgRoot: Buffer.from('<html xmlns="http://www.w3.org/2000/svg"/>'),
    twoRoots: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>'),
    malformed: svg('<rect>'),
    duplicateAttr: svg('<rect x="1" x="2"/>'),
    animateHref: svg('<a href="#x"><set attributeName="href" to="javascript:alert(1)"/></a>'),
    invalidUtf8: Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.from([0xff, 0xfe]), Buffer.from('</svg>')]),
    imageDataUri: svg('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'),
    styleDataUrl: svg('<rect style="fill:url(data:image/png;base64,AAAA)"/>'),
    styleQuotedExternal: svg('<style>.a{fill:url("https://evil.example/a#g")}</style>'),
    cdataImport: svg('<style><![CDATA[@import url(#a);]]></style>'),
    cdataOutsideStyle: svg('<text><![CDATA[x]]></text>'),
    fontFace: svg('<style>@font-face{font-family:x;src:local(x)}</style>'),
    xhtmlPrefix: svg('<h:script>alert(1)</h:script>', ' xmlns:h="http://www.w3.org/1999/xhtml"'),
    svgPrefixScript: svg('<s:script>alert(1)</s:script>', ' xmlns:s="http://www.w3.org/2000/svg"'),
    aliasedXlink: svg('<use x:href="https://evil.example/a.svg#a"/>', ' xmlns:x="http://www.w3.org/1999/xlink"'),
    xmlEvents: svg('<rect ev:event="click"/>', ' xmlns:ev="http://www.w3.org/2001/xml-events"'),
    inertHref: svg('<rect ink:href="https://evil.example"/>', ' xmlns:ink="http://www.inkscape.org/namespaces/inkscape"'),
    inertScriptChild: svg('<ink:x><script>alert(1)</script></ink:x>', ' xmlns:ink="http://www.inkscape.org/namespaces/inkscape"'),
    inertOnHandler: svg('<ink:x onclick="alert(1)"/>', ' xmlns:ink="http://www.inkscape.org/namespaces/inkscape"'),
    undeclaredPrefix: svg('<foo:rect/>'),
    rebindPrefix: svg('<g xmlns:s="http://www.inkscape.org/namespaces/inkscape"><s:script/></g>', ' xmlns:s="http://www.w3.org/2000/svg"'),
    deepNesting: svg('<g>'.repeat(DIAGRAM_LIMITS.maxSvgDepth + 1) + '</g>'.repeat(DIAGRAM_LIMITS.maxSvgDepth + 1)),
  };
  for (const [name, buf] of Object.entries(malicious)) {
    assert.throws(() => validateSvg(buf), ValidationError, `${name} should be rejected`);
  }
});

// ─── PNG assets ──────────────────────────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('accepts a well-formed PNG and reports its dimensions', () => {
  assert.deepEqual(inspectPng(png(3, 2)), { width: 3, height: 2 });
  assert.deepEqual(validateAssetUpload(png(1, 1), 'image/png'), { contentType: 'image/png', width: 1, height: 1 });
});

test('rejects corrupt, oversized or mislabelled PNGs', () => {
  const good = png(2, 2);
  const badCrc = Buffer.from(good); badCrc[good.length - 20] ^= 0xff;
  assert.throws(() => inspectPng(badCrc), ValidationError, 'bad CRC');
  assert.throws(() => inspectPng(Buffer.concat([good, Buffer.from('<script>')])), ValidationError, 'trailing data');
  assert.throws(() => inspectPng(good.subarray(0, good.length - 12)), ValidationError, 'missing IEND');
  const notPng = Buffer.from(good); notPng[1] = 0x00;
  assert.throws(() => inspectPng(notPng), ValidationError, 'bad signature');
  const huge = png(1, 1); huge.writeUInt32BE(DIAGRAM_LIMITS.maxPngDimension + 1, 16);
  assert.throws(() => inspectPng(huge), ValidationError, 'dimension cap (also breaks CRC)');
  assert.throws(() => validateAssetUpload(svg('<rect/>'), 'image/png'), ValidationError, 'SVG labelled as PNG');
  assert.throws(() => validateAssetUpload(good, 'image/svg+xml'), ValidationError, 'PNG labelled as SVG');
  assert.throws(() => validateAssetUpload(good, 'image/gif'), ValidationError, 'other content types');
  assert.throws(() => validateAssetUpload(Buffer.alloc(0), 'image/png'), ValidationError, 'empty body');
  assert.throws(() => validateAssetUpload({}, 'image/png'), ValidationError, 'unparsed body');
  assert.throws(() => validateAssetUpload(Buffer.alloc(DIAGRAM_LIMITS.maxAssetBytes + 1), 'image/png'), ValidationError, 'over 5 MiB');
});

test('validates asset names', () => {
  assert.equal(validateAssetName('  flow.png '), 'flow.png');
  for (const bad of [undefined, '', '   ', 'a\u0000b', 'x'.repeat(DIAGRAM_LIMITS.maxAssetNameChars + 1), ['a']]) {
    assert.throws(() => validateAssetName(bad), ValidationError);
  }
});

// ─── Optimistic revision check (SQL path with a stubbed pg client) ──────────

interface FakeState { canvasType: string; revision: number; updateRows: number; calls: string[] }

function stubDb(state: FakeState): () => void {
  const client = {
    query: async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      state.calls.push(s.split(' ').slice(0, 2).join(' '));
      if (s.startsWith('SELECT canvas_type FROM canvases')) return { rows: [{ canvas_type: state.canvasType }], rowCount: 1 };
      if (s.startsWith('SELECT revision FROM canvas_diagrams')) return { rows: [{ revision: state.revision }], rowCount: 1 };
      if (s.startsWith('SELECT id::text FROM canvas_diagram_assets')) return { rows: [], rowCount: 0 };
      if (s.startsWith('UPDATE canvas_diagrams')) {
        return state.updateRows === 0 ? { rows: [], rowCount: 0 } : { rows: [{ revision: state.revision + 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: (): void => {},
  };
  const m = mock.method(Pool.prototype, 'connect', async () => client);
  return () => m.mock.restore();
}

const CANVAS = randomUUID();

test('saves when the base revision is current and returns revision + 1', async () => {
  const state: FakeState = { canvasType: 'diagram', revision: 3, updateRows: 1, calls: [] };
  const restore = stubDb(state);
  try {
    const a = node();
    const snap = await saveDiagram(CANVAS, { revision: 3, document: doc([a]) });
    assert.equal(snap.revision, 4);
    assert.equal(snap.document.nodes[0]?.id, a.id);
    assert.ok(state.calls.includes('COMMIT'));
    assert.ok(state.calls.includes('INSERT INTO'));
  } finally { restore(); }
});

test('a stale revision is a 409 with the current revision and writes nothing', async () => {
  const state: FakeState = { canvasType: 'diagram', revision: 7, updateRows: 1, calls: [] };
  const restore = stubDb(state);
  try {
    await assert.rejects(saveDiagram(CANVAS, { revision: 5, document: emptyDiagram() }), (err: unknown) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'DIAGRAM_REVISION_CONFLICT');
      assert.deepEqual(err.fields, { revision: '7' });
      return true;
    });
    assert.ok(state.calls.includes('ROLLBACK'));
    assert.ok(!state.calls.includes('UPDATE canvas_diagrams'));
  } finally { restore(); }
});

test('a lost compare-and-swap race is also a 409', async () => {
  const state: FakeState = { canvasType: 'diagram', revision: 2, updateRows: 0, calls: [] };
  const restore = stubDb(state);
  try {
    await assert.rejects(saveDiagram(CANVAS, { revision: 2, document: emptyDiagram() }), (err: unknown) =>
      err instanceof ConflictError && err.code === 'DIAGRAM_REVISION_CONFLICT');
    assert.ok(state.calls.includes('ROLLBACK'));
  } finally { restore(); }
});

test('saving a diagram onto a brainstorm canvas is a 409 type mismatch', async () => {
  const restore = stubDb({ canvasType: 'brainstorm', revision: 0, updateRows: 1, calls: [] });
  try {
    await assert.rejects(saveDiagram(CANVAS, { revision: 0, document: emptyDiagram() }), (err: unknown) =>
      err instanceof ConflictError && err.code === 'CANVAS_TYPE_MISMATCH');
  } finally { restore(); }
});

test('invalid save bodies are 422 before touching the database', async () => {
  const restore = stubDb({ canvasType: 'diagram', revision: 0, updateRows: 1, calls: [] });
  try {
    await assert.rejects(saveDiagram(CANVAS, { revision: 0, document: emptyDiagram(), extra: 1 }), ValidationError);
    await assert.rejects(saveDiagram(CANVAS, { revision: -1, document: emptyDiagram() }), ValidationError);
    await assert.rejects(saveDiagram(CANVAS, [] as unknown), ValidationError);
    const a = node();
    await assert.rejects(saveDiagram(CANVAS, { revision: 0, document: doc([a], [edge(a.id, randomUUID())]) }), ValidationError);
  } finally { restore(); }
});

// ─── Brainstorm-only guards (Athena / card tools) ────────────────────────────

test('brainstorm-only services refuse a diagram canvas with a 409 type mismatch', async () => {
  const diagram = {
    id: randomUUID(), title: 'Arch', canvasType: 'diagram', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  } as unknown as CanvasFull;
  const isMismatch = (e: unknown): boolean => e instanceof ConflictError && (e as ConflictError).code === 'CANVAS_TYPE_MISMATCH';
  const fakeDb = new Proxy({}, { get: () => { throw new Error('database must not be touched'); } }) as unknown as Pool;
  assert.throws(() => mapOutline(diagram), isMismatch);
  assert.throws(() => mapMarkdown(diagram), isMismatch);
  assert.throws(() => cardSummaryBlocks(diagram, randomUUID(), false), isMismatch);
  await assert.rejects(suggestionsFor(diagram, undefined), isMismatch);
  await assert.rejects(buildCanvasContext(fakeDb, diagram, 'what is on this canvas?'), isMismatch);
  await assert.rejects(resolveMapChanges(fakeDb, [], diagram, new Map()), isMismatch);
});
