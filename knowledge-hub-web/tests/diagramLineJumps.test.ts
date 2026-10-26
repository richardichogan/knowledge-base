import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramLineJumpGeometry, lineJumpGeometry, type StrokeRoute } from '../src/features/diagram/diagramLineJumps';
import { emptyDiagram, type DiagramNode } from '../src/features/diagram/diagramTypes';
import { lineGeometry, roundedRoutePath } from '../src/features/diagram/diagramGeometry';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { diagramDrawioXml } from '../src/features/diagram/diagramDrawio';

const stroke = (id: string, points: number[][], width = 1.5): StrokeRoute => ({
  id, points: points.map(([x, y]) => ({ x: x!, y: y! })), width,
});
const horizontal = stroke('under', [[0, 50], [100, 50]]);
const vertical = stroke('over', [[50, 0], [50, 100]]);
const arcs = (d: string | undefined): number => (d?.match(/ A/g) ?? []).length;
const lineJumpPaths = (strokes: StrokeRoute[]): Map<string, string> => lineJumpGeometry(strokes).paths;
const diagramLineJumpPaths = (document: ReturnType<typeof emptyDiagram>): Map<string, string> => diagramLineJumpGeometry(document).paths;
const node = (id: string, x: number, y: number): DiagramNode => ({
  id, kind: 'process', x, y, width: 20, height: 20, label: '', parentId: null, assetId: null,
  fill: '#ffffff', stroke: '#161616', textColor: '#161616', fontSize: 14,
});

test('one deterministic bridge belongs to the later painted stroke without changing input', () => {
  const strokes = [horizontal, vertical];
  const before = structuredClone(strokes);
  const paths = lineJumpPaths(strokes);
  assert.equal(paths.size, 1);
  assert.equal(paths.get('over'), 'M50 0 L50 44 A6 6 90 0 1 50 56 L50 100');
  assert.deepEqual(lineJumpPaths(strokes), paths);
  assert.deepEqual(strokes, before);
  assert.equal(arcs(lineJumpPaths([vertical, horizontal]).get('under')), 1);
  const mask = lineJumpGeometry(strokes).masks.get('under')!;
  assert.deepEqual(mask, [{ d: 'M50 44 A6 6 90 0 1 50 56', width: 5 }]);
  assert.equal(lineJumpGeometry(strokes).masks.has('over'), false);
});

test('junctions, bends, shared endpoints, parallel overlaps and self intersections do not jump', () => {
  const cases = [
    stroke('end', [[50, 50], [50, 100]]),
    stroke('shared', [[0, 50], [50, 100]]),
    stroke('bend', [[50, 0], [50, 50], [100, 80]]),
    stroke('overlap', [[10, 50], [90, 50]]),
    stroke('parallel', [[0, 60], [100, 60]]),
    stroke('outside', [[120, 0], [120, 100]]),
  ];
  for (const other of cases) assert.equal(lineJumpPaths([horizontal, other]).size, 0, other.id);
  assert.equal(lineJumpPaths([stroke('self', [[0, 0], [100, 100], [0, 100], [100, 0]])]).size, 0);
});

test('diagonal, reversed, orthogonal and degenerate segments produce finite paths', () => {
  assert.equal(arcs(lineJumpPaths([horizontal, stroke('diagonal', [[0, 0], [100, 100]])]).get('diagonal')), 1);
  const forward = lineJumpPaths([vertical, horizontal]).get('under')!;
  const reversed = lineJumpPaths([vertical, stroke('reverse', [[100, 50], [0, 50]])]).get('reverse')!;
  assert.match(forward, / A6 6 0 0 1 /);
  assert.match(reversed, / A6 6 180 0 0 /);
  const multi = stroke('multi', [[20, 0], [20, 0], [20, 100], [80, 100], [80, 0]]);
  const path = lineJumpPaths([horizontal, multi]).get('multi')!;
  assert.equal(arcs(path), 2);
  assert.doesNotMatch(path, /NaN|Infinity/);
  assert.ok(path.endsWith('L80 0'));
});

test('close crossings merge into a single bridge; widely spaced crossings stay separate', () => {
  const under = [20, 25, 70].map((x, i) => stroke(String(i), [[x, 0], [x, 100]]));
  const paths = lineJumpPaths([...under, horizontal]);
  assert.equal(arcs(paths.get('under')), 2);
  assert.match(paths.get('under')!, /A8.5 6 0 0 1 31 50/);
});

test('short segments protect their ends and thick strokes get adequate clearance', () => {
  assert.equal(lineJumpPaths([horizontal, stroke('near-end', [[50, 49], [50, 100]])]).size, 0);
  const thick = lineJumpPaths([stroke('under', [[0, 50], [100, 50]], 12), stroke('over', [[50, 0], [50, 100]], 12)]);
  assert.match(thick.get('over')!, /A14 14/);
  const short = lineJumpPaths([horizontal, stroke('short', [[50, 46], [50, 54]])]);
  assert.match(short.get('short')!, /A3 3/);
});

test('movement removes obsolete bridges and hidden ink never causes one', () => {
  assert.equal(arcs(lineJumpPaths([horizontal, vertical]).get('over')), 1);
  assert.equal(lineJumpPaths([horizontal, stroke('over', [[150, 0], [150, 100]])]).size, 0);
  const document = emptyDiagram();
  document.nodes = [
    { ...node('a', 0, 0), kind: 'line', ...lineGeometry({ x: 0, y: 50 }, { x: 100, y: 50 }), stroke: 'none' },
    { ...node('b', 0, 0), kind: 'line', ...lineGeometry({ x: 50, y: 0 }, { x: 50, y: 100 }) },
  ];
  assert.equal(diagramLineJumpPaths(document).size, 0);
  document.nodes[0]!.stroke = '#161616';
  assert.equal(arcs(diagramLineJumpPaths(document).get('b')), 1);
  document.nodes.reverse();
  assert.equal(arcs(diagramLineJumpPaths(document).get('a')), 1);
});

test('SVG and PNG source share bridge paths, styles, arrowheads and unchanged labels/routes', async () => {
  const document = emptyDiagram();
  document.nodes = [node('left', -20, 40), node('right', 100, 40), node('top', 40, -20), node('bottom', 40, 100)];
  document.edges = [
    { id: 'h', sourceId: 'left', targetId: 'right', sourcePort: 'right', targetPort: 'left',
      route: 'straight', waypoints: [], label: '', stroke: '#161616', dashed: false, arrows: 'end' },
    { id: 'v', sourceId: 'top', targetId: 'bottom', sourcePort: 'bottom', targetPort: 'top',
      route: 'straight', waypoints: [], label: 'Flow', stroke: '#0f62fe', strokeWidth: 4, dashed: true, arrows: 'both' },
  ];
  const before = structuredClone(document);
  const d = diagramLineJumpPaths(document).get('v')!;
  assert.equal(arcs(d), 1);
  for (const background of ['white', 'transparent'] as const) {
    const svg = await diagramSvg(document, new Map(), background);
    assert.ok(svg.includes(`<path d="${d}" fill="none" stroke="#0f62fe" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 4" marker-end="url(#arrow-1)" marker-start="url(#arrow-1)"`));
    assert.ok(svg.includes('>Flow</tspan>'));
    assert.ok(svg.includes('stroke="#8d8d8d"'), 'the other connector uses the modern standard ink');
    assert.ok(svg.includes('mask="url(#jump-0)"'));
    assert.ok(svg.includes('<mask id="jump-0" maskUnits="userSpaceOnUse"'));
  }
  assert.deepEqual(document, before);
  const xml = diagramDrawioXml(document, new Map());
  assert.equal((xml.match(/jumpStyle=arc;jumpSize=6/g) ?? []).length, 2);
});

test('rounded connector bends preserve endpoints and clear bridge arcs', () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 60 }];
  const before = structuredClone(points);
  assert.equal(roundedRoutePath(points), 'M0,0 L10,0 Q20,0 20,10 L20,60');
  assert.deepEqual(points, before);
  assert.doesNotMatch(roundedRoutePath([points[0]!, points[0]!, points[2]!]), /NaN|Infinity/);
  const route = { ...stroke('rounded', [[50, 0], [50, 100], [100, 100]]), cornerRadius: 10 };
  const geometry = lineJumpGeometry([horizontal, route]);
  assert.match(geometry.paths.get('rounded')!, /A6 6 90 0 1 50 56 L50 90 Q50 100 60 100 L100 100/);
  assert.equal(geometry.masks.get('under')?.length, 1);
});

test('standalone-line export shares the live bridge, dotted stroke and no arrowheads', async () => {
  const document = emptyDiagram();
  document.nodes = [
    { ...node('under', 0, 0), kind: 'line', ...lineGeometry({ x: 0, y: 50 }, { x: 100, y: 50 }) },
    { ...node('over', 0, 0), kind: 'line', ...lineGeometry({ x: 50, y: 0 }, { x: 50, y: 100 }), strokeStyle: 'dotted', strokeWidth: 4 },
  ];
  const svg = await diagramSvg(document, new Map(), 'transparent');
  assert.ok(svg.includes(`d="${diagramLineJumpPaths(document).get('over')}"`));
  assert.ok(svg.includes('stroke-linecap="round"'));
  assert.doesNotMatch(svg, /marker-(start|end)=/);
  assert.equal((diagramDrawioXml(document, new Map()).match(/jumpStyle=arc;jumpSize=6/g) ?? []).length, 2);
});
