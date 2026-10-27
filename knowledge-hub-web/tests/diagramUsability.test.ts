import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignMovingBounds, diagramGridSize } from '../src/features/diagram/diagramAlignment';
import { HEXAGON_INSET, hexagonShapePath, pointInNode, portPoint, normalizeDocument } from '../src/features/diagram/diagramGeometry';
import { diagramTextLayout } from '../src/features/diagram/diagramText';
import { footnoteAnchor } from '../src/features/diagram/diagramAnnotations';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { diagramDrawioXml } from '../src/features/diagram/diagramDrawio';
import { emptyDiagram, type DiagramNode } from '../src/features/diagram/diagramTypes';
import { readThinkLocation, diagramLocation } from '../src/notes/thinkLocation';
import { readableClipboardText } from '../src/utils/clipboardText';
import { entityLinkHref, linkPlainMentions } from '../src/notes/entityLinks';
import { insertChatMention } from '../src/chat/mentions';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { prepareDesignChat, setDesignChatBridge } from '../src/utils/activeBlockNoteEditor';

test('standalone diagram conversations bypass Design preparation, including drill-down conversation owners', async () => {
  const owner = 'map:44444444-4444-4444-8444-444444444444';
  assert.equal(await prepareDesignChat(owner), undefined);
  let prepared = false;
  const release = setDesignChatBridge('55555555-5555-4555-8555-555555555555', async () => {
    prepared = true;
    throw new Error('Unrelated Design must not block a standalone diagram');
  });
  try {
    assert.equal(await prepareDesignChat(owner), undefined);
    assert.equal(prepared, false);
  } finally { release(); }
});

test('Design-owned diagram conversations retain save preparation, completion and missing-owner protection', async () => {
  const owner = '55555555-5555-4555-8555-555555555555';
  await assert.rejects(prepareDesignChat(owner), /Reopen the Design/);
  let prepared = false;
  let finished: boolean | undefined;
  const release = setDesignChatBridge(owner, async () => {
    prepared = true;
    return async changed => { finished = changed; };
  });
  try {
    await assert.rejects(prepareDesignChat('another-design'), /Reopen the Design/);
    assert.equal(prepared, false);
    const finish = await prepareDesignChat(owner);
    assert.equal(prepared, true);
    assert.ok(finish);
    await finish(false);
    assert.equal(finished, false);
    await finish(true);
    assert.equal(finished, true);
  } finally { release(); }
  const releaseFailure = setDesignChatBridge(owner, async () => {
    throw new Error('The diagram could not be saved. Retry before continuing.');
  });
  try {
    await assert.rejects(prepareDesignChat(owner), /The diagram could not be saved/);
  } finally { releaseFailure(); }
});

const node = (id: string, x: number, y: number): DiagramNode => ({
  id, x, y, width: 100, height: 60, kind: 'process', label: id, fill: '#ffffff',
  stroke: '#161616', textColor: '#161616', fontSize: 14, assetId: null, parentId: null,
});

test('hexagon outlines, hit targets, labels and cardinal connectors agree at different sizes', () => {
  for (const [width, height] of [[160, 80], [80, 160], [24, 24]] as const) {
    const hub: DiagramNode = { ...node('hub', 100, 200), kind: 'hexagon', width, height, label: 'Output' };
    assert.equal(pointInNode(hub, { x: hub.x + hub.width / 2, y: hub.y + hub.height / 2 }), true);
    assert.equal(pointInNode(hub, { x: hub.x + 1, y: hub.y + 1 }), false);
    assert.equal(pointInNode(hub, { x: hub.x + hub.width - 1, y: hub.y + hub.height - 1 }), false);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      assert.equal(pointInNode(hub, portPoint(hub, side, hub.kind)), true, `${side} port remains on the outline`);
    }
    assert.equal((hexagonShapePath(hub).match(/L/g) ?? []).length, 5);
    assert.deepEqual(normalizeDocument({ ...emptyDiagram(), nodes: [hub] }).nodes[0], hub);
  }
  const hub: DiagramNode = { ...node('hub', 100, 200), kind: 'hexagon', width: 160, height: 80, label: 'Output' };
  assert.equal(hexagonShapePath(hub), 'M132,200 L228,200 L260,240 L228,280 L132,280 L100,240 Z');
  const label = diagramTextLayout(hub);
  assert.deepEqual(label.lines, ['Output']);
  assert.equal(label.x, 180);
  assert.equal(label.y, 240);
  for (const textAlign of ['left', 'right'] as const) {
    const aligned = diagramTextLayout({ ...hub, textAlign });
    assert.ok(aligned.x >= hub.x + hub.width * HEXAGON_INSET);
    assert.ok(aligned.x <= hub.x + hub.width * (1 - HEXAGON_INSET));
  }
  assert.deepEqual(footnoteAnchor({ nodes: [hub], edges: [] }, hub.id), { x: 228, y: 202 });
});

test('hexagon SVG and editable draw.io exports preserve the shape and label', async () => {
  const hub: DiagramNode = { ...node('hub', 100, 200), kind: 'hexagon', width: 160, height: 80, label: 'Output' };
  const doc = { ...emptyDiagram(), nodes: [hub] };
  const svg = await diagramSvg(doc, new Map(), 'white', false);
  assert.ok(svg.includes(`d="${hexagonShapePath(hub)}"`));
  assert.ok(svg.includes('Output'));
  const drawio = await diagramDrawioXml(doc, new Map());
  assert.ok(drawio.includes('shape=hexagon;'));
  assert.ok(drawio.includes('perimeter=hexagonPerimeter;'));
  assert.ok(drawio.includes('size=0.2;'));
  assert.ok(drawio.includes('Output'));
});

test('new diagram navigation replaces stale note/spark routing and survives a reload', () => {
  const original = new URLSearchParams('noteId=old&view=sparks&footnote=4&projectId=reckitt');
  const next = diagramLocation(original, 'new-diagram');
  assert.deepEqual(readThinkLocation(next), { view: 'canvas', id: 'new-diagram' });
  assert.equal(original.get('noteId'), 'old', 'navigation must not mutate router params');
  assert.equal(next.get('projectId'), 'reckitt');
  assert.deepEqual(readThinkLocation(new URLSearchParams(next.toString())), { view: 'canvas', id: 'new-diagram' });
  assert.deepEqual(readThinkLocation(new URLSearchParams('mapId=child&noteId=stale&footnote=2')), { view: 'canvas', id: 'child', footnote: 2 });
  assert.deepEqual(readThinkLocation(new URLSearchParams('noteId=note')), { view: 'notes', id: 'note' });
  assert.deepEqual(readThinkLocation(new URLSearchParams('view=sparks')), { view: 'sparks' });
});

test('alignment snaps centres and edges exactly within zoom-adjusted tolerance, leaving distant shapes alone', () => {
  const moving = { x: 0, y: 0, width: 100, height: 60 };
  const other = node('reference', 200, 100);
  const near = alignMovingBounds(moving, [other], { x: 198, y: 98 }, 5);
  assert.deepEqual(near.delta, { x: 200, y: 100 });
  assert.deepEqual(near.guides, [
    { axis: 'x', value: 200, kind: 'edge' }, { axis: 'x', value: 250, kind: 'centre' }, { axis: 'x', value: 300, kind: 'edge' },
    { axis: 'y', value: 100, kind: 'edge' }, { axis: 'y', value: 130, kind: 'centre' }, { axis: 'y', value: 160, kind: 'edge' },
  ]);
  const far = alignMovingBounds(moving, [other], { x: 170, y: 80 }, 5);
  assert.deepEqual(far, { delta: { x: 170, y: 80 }, guides: [] });
  const zoomed = alignMovingBounds(moving, [other], { x: 198, y: 98 }, 5 / 4);
  assert.deepEqual(zoomed.guides, []);
  const centre = alignMovingBounds({ x: 0, y: 0, width: 60, height: 20 }, [other], { x: 219, y: 119 }, 2);
  assert.deepEqual(centre.delta, { x: 220, y: 120 });
});

test('fine grid preferences round-trip and remain consistent in SVG and draw.io exports', async () => {
  assert.equal(diagramGridSize(undefined), 10);
  assert.equal(diagramGridSize(13), 10);
  for (const gridSize of [5, 10, 20, 40]) {
    const doc = normalizeDocument({ ...emptyDiagram(), nodes: [node('one', 0, 0)], gridSize });
    assert.equal(doc.gridSize, gridSize);
    const svg = await diagramSvg(doc, new Map(), 'white', true);
    assert.ok(svg.includes(`id="export-grid" width="${gridSize}" height="${gridSize}"`));
    const xml = await diagramDrawioXml(doc, new Map());
    assert.ok(xml.includes(`gridSize="${gridSize}"`));
  }
});

test('Athena structured clipboard text becomes prose; ordinary JSON and diagram object clipboard remain untouched', () => {
  const blocks = [{ type: 'paragraph', content: [{ type: 'text', text: 'Company ' }, { type: 'text', text: 'context' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Programme details' }] }];
  assert.equal(readableClipboardText(JSON.stringify(blocks), ''), 'Company context\nProgramme details');
  assert.equal(readableClipboardText(JSON.stringify({ contentJson: JSON.stringify(blocks) }), ''), 'Company context\nProgramme details');
  assert.equal(readableClipboardText('A plain description', ''), 'A plain description');
  assert.equal(readableClipboardText('{"setting":42}', ''), '{"setting":42}');
  assert.equal(readableClipboardText('[not JSON]', ''), '[not JSON]');
  const diagram = '{"type":"kh-diagram/v1","nodes":[],"edges":[]}';
  assert.equal(readableClipboardText(diagram, ''), diagram);
});

test('companies participate in note linking and chat mentions with stable encoded routes', () => {
  const href = entityLinkHref('company', 'company & id');
  assert.equal(href, '/companies?companyId=company%20%26%20id');
  const target = { type: 'company' as const, id: 'bcg', title: 'BCG', href };
  const converted = linkPlainMentions([{ type: 'paragraph', content: [{ type: 'text', text: 'BCG works on Reckitt' }] }], target);
  assert.equal(converted.count, 1);
  assert.match(JSON.stringify(converted.blocks), /"entityType":"company"/);
  assert.equal(insertChatMention('Ask @BC', { start: 4, end: 7 }, { ...target, detail: '' }).input, `Ask @[BCG](${href}) `);
});

test('diagram popovers enter the top layer, stay within the viewport and release listeners on close', async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/hooks/useAnchoredPopovers.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  });
  let cleanup: (() => void) | undefined;
  let open = false;
  let observerDisconnected = false;
  const listeners = new Map<string, () => void>();
  const style: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  const element = {
    style, offsetWidth: 400, offsetHeight: 500,
    parentElement: { getBoundingClientRect: () => ({ left: 480, top: 750, bottom: 800 }) },
    setAttribute: (name: string, value: string) => { attributes[name] = value; },
    showPopover: () => { open = true; }, hidePopover: () => { open = false; },
    matches: (selector: string) => selector === ':popover-open' && open,
  };
  const window = {
    innerWidth: 500, innerHeight: 400,
    addEventListener: (name: string, listener: () => void, capture = false) => { listeners.set(`${name}:${capture}`, listener); },
    removeEventListener: (name: string, listener: () => void, capture = false) => {
      assert.equal(listeners.get(`${name}:${capture}`), listener);
      listeners.delete(`${name}:${capture}`);
    },
  };
  const root = { current: { querySelectorAll: () => [element] } };
  const module = { exports: {} as { useAnchoredPopovers(target: typeof root, selector: string | null, above?: boolean): void } };
  const context = createContext({ module, exports: module.exports, window,
    ResizeObserver: class {
      observe(): void {}
      disconnect(): void { observerDisconnected = true; }
    },
    require: () => ({ useLayoutEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); } }),
  });
  runInContext(compiled.outputFiles[0]!.text, context);
  module.exports.useAnchoredPopovers(root, '.dg-popover');
  assert.equal(attributes['popover'], 'manual');
  assert.equal(open, true);
  assert.equal(style['left'], '92px');
  assert.equal(style['top'], '8px');
  assert.equal(style['maxHeight'], '384px');
  window.innerWidth = 1200; window.innerHeight = 900;
  listeners.get('resize:false')!();
  assert.equal(style['left'], '480px');
  assert.equal(style['top'], '392px');
  cleanup!();
  assert.equal(open, false);
  assert.equal(listeners.size, 0);
  assert.equal(observerDisconnected, true);
  module.exports.useAnchoredPopovers(root, '.ai-move__panel', true);
  assert.equal(style['top'], '242px', 'inline Athena menus prefer the space above their trigger');
  cleanup!();
  module.exports.useAnchoredPopovers(root, null);
  assert.equal(cleanup, undefined);
});
