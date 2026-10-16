/**
 * draw.io export tests. Run from knowledge-hub-backend:
 *   node --import tsx/esm ../knowledge-hub-web/src/features/diagram/tests/diagramDrawio.test.ts
 */
import type { DiagramDocument, DiagramEdge, DiagramNode } from '../diagramTypes';
import { diagramDrawioXml, drawioImage } from '../diagramDrawio';
import { exportFileName } from '../diagramExport';

let failures = 0;
let passes = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passes++; } catch (e) { failures++; console.error(`✗ ${name}\n  ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

const node = (id: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id, kind: 'process', label: id, x: 0, y: 0, width: 100, height: 50, parentId: null,
  fill: '#fff', stroke: '#000', textColor: '#000', fontSize: 14, assetId: null, ...extra,
});
const edge = (id: string, s: string, t: string, extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id, sourceId: s, targetId: t, sourcePort: 'right', targetPort: 'left', route: 'straight', waypoints: [],
  label: '', stroke: '#000', dashed: false, arrows: 'end', ...extra,
});
const doc = (nodes: DiagramNode[], edges: DiagramEdge[] = [], extra: Partial<DiagramDocument> = {}): DiagramDocument =>
  ({ version: 1, nodes, edges, grid: true, viewport: { x: 0, y: 0, zoom: 1 }, ...extra });

const cell = (xml: string, id: string): string => {
  const m = new RegExp(`<(mxCell|UserObject)[^>]*id="${id}"[\\s\\S]*?</(mxCell|UserObject)>`).exec(xml);
  if (m === null) throw new Error(`no cell ${id}`);
  return m[0];
};

test('wraps the diagram in an mxfile with the root cells and page name', () => {
  const xml = diagramDrawioXml(doc([node('a')]), new Map(), { name: 'R&D <plan>' });
  ok(xml.startsWith('<?xml'), 'xml header');
  ok(xml.includes('<diagram id="athena" name="R&amp;D &lt;plan&gt;">'), 'escaped page name');
  ok(xml.includes('<mxCell id="0"/><mxCell id="1" parent="0"/>'), 'root cells');
  ok(xml.includes('grid="1"'), 'grid on');
});

test('shapes map to draw.io styles, children are relative to their container', () => {
  const xml = diagramDrawioXml(doc([
    node('box', { kind: 'container', x: 100, y: 200, width: 400, height: 300, label: 'Group' }),
    node('dec', { kind: 'decision', x: 140, y: 260, parentId: 'box', strokeStyle: 'dashed' }),
    node('lane', { kind: 'swimlane', x: 700, y: 0, width: 600, height: 200 }),
    node('doc', { kind: 'document', x: 700, y: 300, fill: 'none' }),
  ]), new Map());
  const box = cell(xml, 'box');
  ok(/style="swimlane;[^"]*startSize=\d+;[^"]*container=1;"/.test(box), 'container is a draw.io container');
  ok(box.includes('x="100" y="200" width="400" height="300"'), 'container absolute');
  const dec = cell(xml, 'dec');
  ok(dec.includes('rhombus;') && dec.includes('dashed=1') && dec.includes('parent="box"'), 'decision dashed in container');
  ok(dec.includes('x="40" y="60"'), `child relative geometry: ${dec}`);
  ok(cell(xml, 'lane').includes('horizontal=0'), 'swimlane header on the left');
  ok(cell(xml, 'doc').includes('shape=document') && cell(xml, 'doc').includes('fillColor=none'), 'document, no fill');
  ok(xml.indexOf('id="box"') < xml.indexOf('id="dec"'), 'parents before children');
});

test('arrow shapes become draw.io single arrows facing the same way', () => {
  const xml = diagramDrawioXml(doc([
    node('east', { kind: 'arrow', width: 160, height: 80 }),
    node('north', { kind: 'arrow', width: 80, height: 160, arrowDirection: 'up' }),
  ]), new Map());
  const east = cell(xml, 'east');
  ok(east.includes('shape=singleArrow') && east.includes('direction=east') && east.includes('arrowWidth=0.6') && east.includes('arrowSize=0.375'), east);
  ok(cell(xml, 'north').includes('direction=north'), 'up becomes north');
});

test('connectors keep ports, bends, arrows, label offset and description', () => {
  const xml = diagramDrawioXml(doc([node('a'), node('b', { x: 300 })], [
    edge('e', 'a', 'b', { route: 'orthogonal', sourcePort: 'bottom', targetPort: 'top', waypoints: [{ x: 50, y: 120 }], arrows: 'both', dashed: true,
      label: 'calls\nAPI', labelOffset: { x: 5, y: -10 }, description: 'HTTPS' }),
    edge('missing', 'a', 'zzz'),
  ]), new Map());
  const e = cell(xml, 'e');
  ok(e.startsWith('<UserObject') && e.includes('tooltip="HTTPS"'), 'description as tooltip');
  ok(e.includes('label="calls&lt;br&gt;API"'), 'line break kept');
  ok(e.includes('edgeStyle=orthogonalEdgeStyle') && e.includes('exitX=0.5;exitY=1') && e.includes('entryX=0.5;entryY=0'), 'ports');
  ok(e.includes('startArrow=block') && e.includes('endArrow=block') && e.includes('dashed=1'), 'arrows and dash');
  ok(e.includes('<mxPoint x="50" y="120"/>') && e.includes('<mxPoint x="5" y="-10" as="offset"/>'), 'waypoint and label offset');
  ok(e.includes('source="a" target="b"'), 'terminals');
  ok(!xml.includes('id="missing"'), 'dangling connector skipped');
});

test('lines, icons, footnotes and the colour key come across', () => {
  const xml = diagramDrawioXml(doc([
    node('l', { kind: 'line', x: 0, y: 400, width: 200, height: 0, stroke: '#da1e28' }),
    node('img', { kind: 'image', x: 0, y: 100, width: 80, height: 80, assetId: 'asset1', label: 'Icon', stroke: '#0f62fe' }),
    node('a', { x: 300, description: 'Explains A' }),
  ], [], {
    footnotes: [{ id: 'f1', targetId: 'a', source: 'description' }],
    legend: { visible: true, position: 'bottom-right', entries: [{ colour: '#0f62fe', label: 'Platform' }] },
  }), new Map([['asset1', 'data:image/png;base64,QUJD']]));
  const line = cell(xml, 'l');
  ok(line.includes('edge="1"') && line.includes('as="sourcePoint"') && line.includes('endArrow=none'), 'line is a free edge');
  ok(cell(xml, 'img-image').includes('image=data:image/png,QUJD') && cell(xml, 'img-image').includes('parent="img"'), 'icon embedded');
  ok(cell(xml, 'a').includes('tooltip="Explains A"'), 'shape description as tooltip');
  ok(cell(xml, 'footnote-f1').includes('value="1"') && cell(xml, 'footnote-f1').includes('fillColor=#0f62fe'), 'badge');
  ok(cell(xml, 'note-f1').includes('&lt;b&gt;a&lt;/b&gt;&lt;br&gt;Explains A'), 'note text');
  ok(!xml.includes('id="notes-frame"'), 'notes have no surrounding frame');
  ok(cell(xml, 'notes-divider').includes('dashed=1') && cell(xml, 'notes-divider').includes('endArrow=none'),
    'notes have a subtle dashed divider without arrows');
  ok(xml.includes('value="Key"') && xml.includes('value="Platform"'), 'colour key');
  const off = diagramDrawioXml(doc([node('a')], [], { footnotes: [{ id: 'f1', targetId: 'a', source: 'description' }], legend: { visible: true, position: 'bottom-right', entries: [] } }),
    new Map(), { footnotes: false, legend: false });
  ok(!off.includes('footnote-f1') && !off.includes('notes-divider') && !off.includes('value="Key"'), 'annotations can be left out');
});

test('helpers', () => {
  ok(drawioImage('data:image/svg+xml;base64,PHN2Zz4=') === 'data:image/svg+xml,PHN2Zz4=', 'draw.io data URL');
  ok(exportFileName('Imagine: Build/Run?', 'drawio') === 'Imagine Build Run.drawio', exportFileName('Imagine: Build/Run?', 'drawio'));
  ok(exportFileName('  ', 'png') === 'diagram.png', 'fallback name');
});

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1;
