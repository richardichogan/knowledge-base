/**
 * Geometry tests for the diagram editor. No test runner is installed in knowledge-hub-web, so this file is a
 * self-contained script. Run from knowledge-hub-backend (which provides tsx):
 *   node --import tsx/esm ../knowledge-hub-web/src/features/diagram/tests/diagramGeometry.test.ts
 */
import type { DiagramDocument, DiagramEdge, DiagramNode, DiagramPoint } from '../diagramTypes';
import {
  alignNodes, boundsOf, diagramBounds, edgePoints, canParent, cloneSelection, containerAt, distributeNodes, edgeRoute, facingPorts, fitSize,
  fitViewport, hitTestEdge, hitTestNode, insertWaypoint, nearestPort, nodeMap, nodesInRect, normalizeDocument,
  orthogonalRoute, pointAlong, portPoint, removeSelection, renderOrder, reorderNodes, resizeRect, setParent,
  simplifyPolyline, topLevelSelection, translateNodes, wrapText, zoomAt, screenToWorld,
} from '../diagramGeometry';

let failures = 0;
let passes = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passes++; } catch (e) { failures++; console.error(`✗ ${name}\n  ${e instanceof Error ? e.message : String(e)}`); }
}
function eq(actual: unknown, expected: unknown, msg = ''): void {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b} but got ${a}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
function near(a: number, b: number, msg = ''): void { if (Math.abs(a - b) > 1e-6) throw new Error(`${msg} expected ${b} but got ${a}`); }

const node = (id: string, x: number, y: number, w = 100, h = 50, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id, kind: 'process', label: id, x, y, width: w, height: h, parentId: null,
  fill: '#fff', stroke: '#000', textColor: '#000', fontSize: 14, assetId: null, ...extra,
});
const edge = (id: string, s: string, t: string, extra: Partial<DiagramEdge> = {}): DiagramEdge => ({
  id, sourceId: s, targetId: t, sourcePort: 'right', targetPort: 'left', route: 'straight', waypoints: [],
  label: '', stroke: '#000', dashed: false, arrows: 'end', ...extra,
});
const doc = (nodes: DiagramNode[], edges: DiagramEdge[] = []): DiagramDocument => ({ version: 1, nodes, edges, grid: true, viewport: { x: 0, y: 0, zoom: 1 } });
const isOrthogonal = (pts: DiagramPoint[]): boolean => pts.every((p, i) => i === 0 || p.x === (pts[i - 1] as DiagramPoint).x || p.y === (pts[i - 1] as DiagramPoint).y);

// ── Bounds ──
test('boundsOf unions rects', () => {
  eq(boundsOf([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: -5, width: 5, height: 5 }]), { x: 0, y: -5, width: 25, height: 15 });
  eq(boundsOf([]), null);
});

test('fitViewport centres and caps zoom at 1', () => {
  const v = fitViewport({ x: 0, y: 0, width: 100, height: 100 }, 1000, 800, 40, 0.1, 4);
  eq(v, { x: 450, y: 350, zoom: 1 });
  const big = fitViewport({ x: 0, y: 0, width: 2000, height: 1000 }, 1000, 800, 0, 0.1, 4);
  near(big.zoom, 0.5);
});

test('zoomAt keeps the screen point anchored', () => {
  const v = { x: 30, y: 40, zoom: 1 };
  const before = screenToWorld({ x: 200, y: 100 }, v);
  const after = screenToWorld({ x: 200, y: 100 }, zoomAt(v, { x: 200, y: 100 }, 2));
  near(before.x, after.x); near(before.y, after.y);
});

// ── Ports & attachment ──
test('portPoint returns side midpoints', () => {
  const r = { x: 10, y: 20, width: 100, height: 40 };
  eq(portPoint(r, 'top'), { x: 60, y: 20 });
  eq(portPoint(r, 'right'), { x: 110, y: 40 });
  eq(portPoint(r, 'bottom'), { x: 60, y: 60 });
  eq(portPoint(r, 'left'), { x: 10, y: 40 });
  eq(nearestPort(r, { x: 0, y: 41 }), 'left');
  eq(facingPorts(r, { x: 300, y: 25, width: 10, height: 10 }), ['right', 'left']);
  eq(facingPorts(r, { x: 50, y: 300, width: 10, height: 10 }), ['bottom', 'top']);
});

test('edges re-attach when a node moves', () => {
  const d = doc([node('a', 0, 0), node('b', 300, 0)], [edge('e', 'a', 'b')]);
  const before = edgeRoute(d.edges[0] as DiagramEdge, nodeMap(d.nodes));
  eq(before, [{ x: 100, y: 25 }, { x: 300, y: 25 }]);
  const moved = translateNodes(d, ['b'], 0, 100);
  const after = edgeRoute(moved.edges[0] as DiagramEdge, nodeMap(moved.nodes));
  eq(after, [{ x: 100, y: 25 }, { x: 300, y: 125 }]);
});

test('edgeRoute returns null for dangling edges', () => {
  eq(edgeRoute(edge('e', 'a', 'missing'), nodeMap([node('a', 0, 0)])), null);
});

// ── Nesting ──
test('moving a container moves descendants exactly once', () => {
  const d = doc([
    node('c', 0, 0, 400, 300, { kind: 'container' }),
    node('inner', 20, 40, 200, 200, { kind: 'container', parentId: 'c' }),
    node('leaf', 40, 80, 50, 50, { parentId: 'inner' }),
    node('free', 600, 0),
  ], [edge('in', 'inner', 'leaf', { waypoints: [{ x: 10, y: 10 }] }), edge('out', 'leaf', 'free', { waypoints: [{ x: 500, y: 5 }] })]);
  const m = translateNodes(d, ['c', 'leaf'], 10, 5);
  const byId = nodeMap(m.nodes);
  eq([byId.get('c')?.x, byId.get('inner')?.x, byId.get('leaf')?.x, byId.get('free')?.x], [10, 30, 50, 600]);
  eq(m.edges[0]?.waypoints, [{ x: 20, y: 15 }], 'internal bend follows');
  eq(m.edges[1]?.waypoints, [{ x: 500, y: 5 }], 'external bend stays');
});

test('resizing a container keeps child world geometry', () => {
  const d = doc([node('c', 0, 0, 400, 300, { kind: 'container' }), node('k', 50, 50, 40, 40, { parentId: 'c' })]);
  const r = resizeRect(d.nodes[0] as DiagramNode, 'nw', { x: -100, y: -50 });
  eq(r, { x: -100, y: -50, width: 500, height: 350 });
  eq(d.nodes[1], node('k', 50, 50, 40, 40, { parentId: 'c' }));
});

test('resizeRect clamps to minimum and keeps aspect', () => {
  eq(resizeRect({ x: 0, y: 0, width: 100, height: 50 }, 'e', { x: -500, y: 0 }), { x: 0, y: 0, width: 24, height: 50 });
  const r = resizeRect({ x: 0, y: 0, width: 100, height: 50 }, 'se', { x: 200, y: 60 }, { keepAspect: true });
  near(r.width / r.height, 2);
});

test('canParent rejects cycles and non-containers', () => {
  const nodes = [node('c', 0, 0, 400, 300, { kind: 'container' }), node('d', 10, 10, 100, 100, { kind: 'swimlane', parentId: 'c' }), node('p', 500, 0)];
  ok(canParent(nodes, 'p', 'c'), 'process into container');
  ok(!canParent(nodes, 'c', 'd'), 'container into its own child');
  ok(!canParent(nodes, 'c', 'c'), 'self');
  ok(!canParent(nodes, 'c', 'p'), 'into process');
  eq(setParent(nodes, ['c', 'p'], 'd').map((n) => n.parentId), [null, 'c', 'd']);
});

test('topLevelSelection skips nodes whose ancestor is selected', () => {
  const nodes = [node('c', 0, 0, 400, 300, { kind: 'container' }), node('k', 10, 10, 10, 10, { parentId: 'c' }), node('x', 0, 0)];
  eq(topLevelSelection(nodes, ['k', 'c', 'x']), ['c', 'x']);
});

test('renderOrder paints parents before children regardless of array order', () => {
  const nodes = [node('k', 10, 10, 10, 10, { parentId: 'c' }), node('x', 0, 0), node('c', 0, 0, 400, 300, { kind: 'container' })];
  eq(renderOrder(nodes).map((n) => n.id), ['x', 'c', 'k']);
});

// ── Orthogonal routing ──
test('orthogonal route between facing ports is axis aligned and avoids boxes', () => {
  const a = { x: 0, y: 0, width: 100, height: 50 }; const b = { x: 300, y: 200, width: 100, height: 50 };
  const pts = orthogonalRoute(portPoint(a, 'right'), 'right', a, portPoint(b, 'left'), 'left', b);
  ok(isOrthogonal(pts), `not orthogonal: ${JSON.stringify(pts)}`);
  eq(pts[0], { x: 100, y: 25 }); eq(pts[pts.length - 1], { x: 300, y: 225 });
  eq(pts.length, 4, 'one mid-x jog');
});

test('orthogonal route doubling back still leaves through the port', () => {
  const a = { x: 300, y: 0, width: 100, height: 50 }; const b = { x: 0, y: 0, width: 100, height: 50 };
  const pts = orthogonalRoute(portPoint(a, 'right'), 'right', a, portPoint(b, 'left'), 'left', b);
  ok(isOrthogonal(pts), 'orthogonal');
  ok((pts[1] as DiagramPoint).x > 400, 'leaves rightwards');
  ok((pts[pts.length - 2] as DiagramPoint).x < 0, 'enters from the left');
});

test('orthogonal route passes through waypoints', () => {
  const a = { x: 0, y: 0, width: 100, height: 50 }; const b = { x: 300, y: 0, width: 100, height: 50 };
  const w = { x: 200, y: 150 };
  const pts = orthogonalRoute(portPoint(a, 'right'), 'right', a, portPoint(b, 'left'), 'left', b, [w]);
  ok(isOrthogonal(pts), `orthogonal ${JSON.stringify(pts)}`);
  ok(pts.some((p) => p.x === w.x && p.y === w.y), 'contains waypoint');
});

test('simplifyPolyline removes duplicates and collinear points', () => {
  eq(simplifyPolyline([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
});

test('insertWaypoint keeps waypoints ordered along the route', () => {
  const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }];
  const r = insertWaypoint(route, [{ x: 150, y: 0 }], { x: 50, y: 0 });
  eq(r.index, 0); eq(r.waypoints, [{ x: 50, y: 0 }, { x: 150, y: 0 }]);
  eq(pointAlong(route, 0.5), { x: 100, y: 0 });
});

// ── Hit detection ──
test('hitTestNode returns topmost child and respects diamond shape', () => {
  const nodes = [node('c', 0, 0, 400, 300, { kind: 'container' }), node('k', 50, 50, 100, 100, { parentId: 'c' }), node('d', 500, 0, 100, 100, { kind: 'decision' })];
  eq(hitTestNode(nodes, { x: 60, y: 60 })?.id, 'k');
  eq(hitTestNode(nodes, { x: 300, y: 250 })?.id, 'c');
  eq(hitTestNode(nodes, { x: 550, y: 50 })?.id, 'd');
  eq(hitTestNode(nodes, { x: 505, y: 5 }), null, 'diamond corner is empty');
  eq(hitTestNode(nodes, { x: 60, y: 60 }, new Set(['k']))?.id, 'c');
  eq(containerAt(nodes, { x: 60, y: 60 })?.id, 'c');
});

test('hitTestEdge finds the closest edge within tolerance', () => {
  const nodes = [node('a', 0, 0), node('b', 300, 0)];
  const edges = [edge('e', 'a', 'b')];
  eq(hitTestEdge(edges, nodeMap(nodes), { x: 200, y: 28 }, 5)?.id, 'e');
  eq(hitTestEdge(edges, nodeMap(nodes), { x: 200, y: 60 }, 5), null);
});

test('nodesInRect only takes wholly contained nodes', () => {
  eq(nodesInRect([node('a', 0, 0), node('b', 90, 0)], { x: -1, y: -1, width: 150, height: 60 }), ['a']);
});

// ── Arrangement / clone / delete ──
test('align and distribute', () => {
  const d = doc([node('a', 0, 0), node('b', 50, 100), node('c', 400, 30)]);
  eq(alignNodes(d, ['a', 'b', 'c'], 'left').nodes.map((n) => n.x), [0, 0, 0]);
  eq(alignNodes(d, ['a', 'b', 'c'], 'bottom').nodes.map((n) => n.y), [100, 100, 100]);
  eq(distributeNodes(d, ['a', 'b', 'c'], 'horizontal').nodes.map((n) => n.x), [0, 200, 400]);
});

test('reorderNodes moves within z-order', () => {
  const nodes = [node('a', 0, 0), node('b', 0, 0), node('c', 0, 0)];
  eq(reorderNodes(nodes, ['a'], 'front').map((n) => n.id), ['b', 'c', 'a']);
  eq(reorderNodes(nodes, ['c'], 'back').map((n) => n.id), ['c', 'a', 'b']);
  eq(reorderNodes(nodes, ['a'], 'forward').map((n) => n.id), ['b', 'a', 'c']);
  eq(reorderNodes(nodes, ['c'], 'backward').map((n) => n.id), ['a', 'c', 'b']);
});

test('cloneSelection remaps ids, parents and internal edges', () => {
  const d = doc([node('c', 0, 0, 400, 300, { kind: 'container' }), node('k', 10, 10, 10, 10, { parentId: 'c' }), node('x', 500, 0)],
    [edge('e1', 'c', 'k'), edge('e2', 'k', 'x')]);
  let n = 0;
  const r = cloneSelection(d, ['c'], 20, 20, () => `n${String(++n)}`);
  eq(r.nodes.map((m) => [m.id, m.parentId, m.x]), [['n1', null, 20], ['n2', 'n1', 30]]);
  eq(r.edges.map((e) => [e.sourceId, e.targetId]), [['n1', 'n2']]);
  const kidOnly = cloneSelection(d, ['k'], 0, 0, () => 'z');
  eq(kidOnly.nodes[0]?.parentId, 'c', 'keeps existing parent');
});

test('removeSelection drops descendants and attached edges', () => {
  const d = doc([node('c', 0, 0, 400, 300, { kind: 'container' }), node('k', 10, 10, 10, 10, { parentId: 'c' }), node('x', 500, 0)],
    [edge('e1', 'k', 'x'), edge('e2', 'x', 'x')]);
  const r = removeSelection(d, ['c'], ['e2']);
  eq(r.nodes.map((m) => m.id), ['x']); eq(r.edges, []);
});

test('normalizeDocument repairs dangling references and cycles', () => {
  const raw = doc([node('a', 0, 0, 10, 10, { parentId: 'b' }), node('b', 0, 0, 10, 10, { parentId: 'a' }), node('c', 0, 0, 10, 10, { parentId: 'gone' })],
    [edge('e', 'a', 'gone')]);
  const n = normalizeDocument(raw);
  eq(n.edges, []);
  eq(n.nodes.find((m) => m.id === 'c')?.parentId, null);
  ok(n.nodes.some((m) => m.parentId === null && (m.id === 'a' || m.id === 'b')), 'cycle broken');
});

// ── Text & images ──
test('wrapText wraps and ellipsises', () => {
  eq(wrapText('hello world foo', 70, 10), ['hello world', 'foo']);
  const lines = wrapText('one two three four five six', 30, 10, 2);
  eq(lines.length, 2); ok((lines[1] as string).endsWith('…'), 'ellipsis');
});

test('fitSize preserves aspect ratio', () => {
  const s = fitSize(800, 400, 160, 160);
  eq(s, { width: 160, height: 80 });
});

test('diagramBounds pads nodes and full edge routes; empty doc is non-null', () => {
  const d = doc([node('a', 0, 0, 100, 50), node('b', 300, 200, 100, 50)], [edge('e', 'a', 'b', { route: 'orthogonal' })]);
  eq(diagramBounds(d, 10), { x: -10, y: -10, width: 420, height: 270 });
  eq(diagramBounds(doc([]), 5), { x: -5, y: -5, width: 10, height: 10 });
});

test('edgePoints resolves attached routes and returns [] for dangling edges', () => {
  const nodes = [node('a', 0, 0), node('b', 300, 0)];
  eq(edgePoints(edge('e', 'a', 'b'), nodes), [{ x: 100, y: 25 }, { x: 300, y: 25 }]);
  eq(edgePoints(edge('e', 'a', 'gone'), nodes), []);
});

test('diagramBounds includes connector labels', () => {
  const d = doc([node('a', 0, 0, 10, 10), node('b', 0, 100, 10, 10)], [edge('e', 'a', 'b', { sourcePort: 'bottom', targetPort: 'top', label: 'a fairly long connector label' })]);
  const b = diagramBounds(d, 0);
  ok(b.x < 0 && b.x + b.width > 10, 'label widens bounds');
});

console.log(`${String(passes)} passed, ${String(failures)} failed`);
if (failures > 0) (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1;