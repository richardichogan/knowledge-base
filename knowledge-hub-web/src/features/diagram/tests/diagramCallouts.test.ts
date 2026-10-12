import { DIAGRAM_CALLOUT_TYPES, emptyDiagram, type DiagramNode } from '../diagramTypes';
import { calloutLayout } from '../diagramCallouts';
import { diagramTextLayout } from '../diagramText';
import { diagramSvg } from '../diagramExport';
import { diagramDrawioXml } from '../diagramDrawio';
import { cloneSelection, normalizeDocument } from '../diagramGeometry';
import { diffDocuments } from '../diagramAnnotations';

const assert = {
  ok: (value: boolean): void => { if (!value) throw new Error('Expected condition to be true'); },
  equal: (actual: unknown, expected: unknown): void => { if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`); },
  deepEqual: (actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Values differ');
  },
};
const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
function test(name: string, run: () => void | Promise<void>): void { tests.push({ name, run }); }

const plain: DiagramNode = {
  id: 'note', kind: 'text', label: 'Needs review', x: 100, y: 200, width: 200, height: 100,
  parentId: null, fill: 'none', stroke: 'none', textColor: '#161616', fontSize: 16, assetId: null,
};

test('plain text keeps its original layout and has no callout header', async () => {
  assert.equal(calloutLayout(plain), null);
  assert.equal(diagramTextLayout(plain).y, 250);
  const doc = { ...emptyDiagram(), nodes: [plain] };
  assert.ok(!(await diagramSvg(doc, new Map(), 'transparent')).includes('data-callout-type'));
  assert.ok(!diagramDrawioXml(doc, new Map()).includes('-callout-'));
});

test('every callout has a distinct icon, type label and matching SVG/draw.io exports', async () => {
  const paths = new Set<string>();
  for (const calloutType of DIAGRAM_CALLOUT_TYPES) {
    const node = { ...plain, calloutType };
    const header = calloutLayout(node)!;
    paths.add(header.path);
    const doc = { ...emptyDiagram(), nodes: [node] };
    const svg = await diagramSvg(doc, new Map(), 'transparent');
    assert.ok(svg.includes(`data-callout-type="${calloutType}"`));
    assert.ok(svg.includes(`d="${header.path}"`));
    assert.ok(svg.includes(`>${header.label}</text>`));
    const xml = diagramDrawioXml(doc, new Map());
    assert.ok(xml.includes('id="note-callout-icon"'));
    assert.ok(xml.includes(`value="${header.label}"`));
    assert.ok(xml.includes(encodeURIComponent(header.path)));
    assert.ok(xml.includes(`spacingTop=${header.height}`));
  }
  assert.equal(paths.size, DIAGRAM_CALLOUT_TYPES.length);
});

test('body text clears the header at all alignments and supported font sizes', () => {
  for (const fontSize of [10, 16, 24, 36]) {
    for (const textAlign of ['left', 'center', 'right'] as const) {
      for (const textVerticalAlign of ['top', 'middle', 'bottom'] as const) {
        const node = { ...plain, calloutType: 'question' as const, fontSize, textAlign, textVerticalAlign, height: 160 };
        const header = calloutLayout(node)!;
        const body = diagramTextLayout(node);
        const half = (body.lines.length - 1) * fontSize * 1.25 / 2 + fontSize / 2;
        assert.ok(body.y - half >= node.y + header.height);
        assert.ok(body.y + half <= node.y + node.height);
        assert.ok(header.text.x + header.label.length * header.text.fontSize * 0.56 <= node.x + node.width - 4);
      }
    }
  }
});

test('classification survives normalize, duplication and version comparison', () => {
  const node = { ...plain, calloutType: 'risk' as const };
  const doc = { ...emptyDiagram(), nodes: [node] };
  assert.deepEqual(normalizeDocument(JSON.parse(JSON.stringify(doc))), doc);
  const duplicated = cloneSelection(doc, [node.id], 24, 24, () => 'copy');
  assert.equal(duplicated.nodes[0]?.calloutType, 'risk');
  assert.equal(diffDocuments({ nodes: [plain], edges: [] }, doc)[0]?.change, 'changed');
});

void (async () => {
  let failures = 0;
  for (const entry of tests) {
    try { await entry.run(); } catch (error) {
      failures++;
      console.error(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`${tests.length - failures} callout tests passed, ${failures} failed`);
  if (failures > 0) (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1;
})();
