import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiagramEditor } from '../src/features/diagram/DiagramEditor';
import { api } from '../src/services/api';
import type { ApiResponse } from '../src/types';
import type { DiagramDocument, DiagramNode, DiagramSnapshot } from '../src/features/diagram/diagramTypes';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { NoteMaps } from '../src/features/canvas/NoteMaps';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const canvasId = crypto.randomUUID();
const assetId = crypto.randomUUID();
const icon = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0078d4" d="M4 28L14 4H22L30 28H22L18 16L12 28Z"/></svg>'], { type: 'image/svg+xml' });
const assets = new Map<string, Blob>([[assetId, icon]]);
const node = (label: string, kind: DiagramNode['kind'], x: number, y: number, width: number, height: number, parentId: string | null = null): DiagramNode => ({
  id: crypto.randomUUID(), label, kind, x, y, width, height, parentId,
  fill: kind === 'container' || kind === 'swimlane' ? '#fff2cc' : '#ffffff',
  stroke: '#333333', textColor: '#111111', fontSize: 14, assetId: null,
});
const experience = node('Experience', 'container', 40, 60, 160, 420);
const channel = { ...node('Teams / Copilot', 'image', 65, 115, 110, 100, experience.id), assetId };
const runtime = node('Agent Runtime', 'container', 260, 60, 400, 170);
const workforce = node('Workforce agents', 'process', 280, 110, 160, 70, runtime.id);
const business = node('Business agents', 'process', 460, 110, 170, 70, runtime.id);
const bus = node('Agentic Service Bus', 'process', 280, 300, 350, 100);
const data = node('Enterprise data', 'process', 740, 300, 180, 100);
const lifecycle = node('Lifecycle / Agent SDLC', 'swimlane', 40, 550, 880, 160);
const start = node('Start', 'terminator', 65, 600, 125, 65, lifecycle.id);
const decision = node('Approved?', 'decision', 265, 590, 150, 85, lifecycle.id);
const deploy = node('Deploy', 'process', 500, 600, 150, 65, lifecycle.id);
const doc: DiagramDocument = {
  version: 1, grid: true, viewport: { x: 20, y: 20, zoom: 0.8 },
  nodes: [experience, runtime, lifecycle, channel, workforce, business, bus, data, start, decision, deploy],
  edges: [
    { id: crypto.randomUUID(), sourceId: experience.id, targetId: runtime.id, sourcePort: 'right', targetPort: 'left', route: 'straight', waypoints: [], label: '', stroke: '#333333', dashed: false, arrows: 'both' },
    { id: crypto.randomUUID(), sourceId: runtime.id, targetId: bus.id, sourcePort: 'bottom', targetPort: 'top', route: 'orthogonal', waypoints: [], label: 'Coordinate', stroke: '#333333', dashed: false, arrows: 'both' },
    { id: crypto.randomUUID(), sourceId: bus.id, targetId: data.id, sourcePort: 'right', targetPort: 'left', route: 'straight', waypoints: [], label: '', stroke: '#333333', dashed: false, arrows: 'end' },
    { id: crypto.randomUUID(), sourceId: start.id, targetId: decision.id, sourcePort: 'right', targetPort: 'left', route: 'straight', waypoints: [], label: '', stroke: '#333333', dashed: false, arrows: 'end' },
    { id: crypto.randomUUID(), sourceId: decision.id, targetId: deploy.id, sourcePort: 'right', targetPort: 'left', route: 'orthogonal', waypoints: [], label: 'Yes', stroke: '#333333', dashed: false, arrows: 'end' },
  ],
};
let snapshot: DiagramSnapshot = { revision: 0, document: structuredClone(doc) };
let saves = 0;
let conflict = false;
let missingDiagram = false;
const noteId = crypto.randomUUID();
let linkedNotes: Array<{ id: string; title: string }> = [];
let openedNote: string | null = null;
api.getDiagram = async () => {
  if (missingDiagram) throw Object.assign(new Error('Diagram not found'), { isAxiosError: true, response: { status: 404 } });
  return success(structuredClone(snapshot));
};
api.getCanvas = async () => success({
  id: canvasId, title: 'Enterprise architecture / process flow', canvasType: 'diagram',
  description: null, project: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  linkedNotes, nodeCount: snapshot.document.nodes.length, nodes: [], edges: [], viewport: snapshot.document.viewport,
});
api.saveDiagram = async (_id, revision, document) => {
  if (conflict || revision !== snapshot.revision) throw Object.assign(new Error('Another session updated this diagram'), { isAxiosError: true, response: { status: 409 } });
  snapshot = { revision: revision + 1, document: structuredClone(document) }; saves++;
  return success(structuredClone(snapshot));
};
api.getDiagramAsset = async (_id, id) => {
  const blob = assets.get(id);
  if (!blob) throw new Error('Missing fixture asset');
  return blob;
};
api.uploadDiagramAsset = async (_id, blob, name) => {
  const id = crypto.randomUUID(); assets.set(id, blob);
  return success({ id, name, contentType: blob.type });
};
api.updateCanvas = async () => success({
  id: canvasId, title: 'Enterprise architecture / process flow', canvasType: 'diagram',
  description: null, project: null, createdAt: '', updatedAt: '', linkedNotes: [], nodeCount: snapshot.document.nodes.length,
});
api.listCanvases = async (id) => success(id === noteId && linkedNotes.length > 0 ? [{
  id: canvasId, title: 'Enterprise architecture / process flow', canvasType: 'diagram',
  description: null, project: null, createdAt: '', updatedAt: '', linkedNotes, nodeCount: snapshot.document.nodes.length,
}] : []);
api.getNoteSummaries = async () => success({
  items: [{ id: noteId, title: 'Process requirements', contentType: 'note', preview: '', createdAt: '', updatedAt: '', taxonomyTagIds: [] }],
  total: 1, page: 1, pageSize: 100, hasMore: false,
});
api.linkCanvasNote = async () => { linkedNotes = [{ id: noteId, title: 'Process requirements' }]; return api.getCanvas(canvasId); };
api.unlinkCanvasNote = async () => { linkedNotes = []; return api.getCanvas(canvasId); };

const root = createRoot(window.document.getElementById('root')!);
function mountEditor(): void { root.render(
  <QueryClientProvider client={queryClient}>
    <div className="kh-content" style={{ height: '100vh', padding: '24px' }}>
      <div className="notes-editor-area notes-editor-area--map" style={{ height: '100%' }}>
        <DiagramEditor canvasId={canvasId} onDeleted={() => undefined} onOpenNote={(id) => { openedNote = id; }} />
      </div>
      <div hidden><NoteMaps noteId={noteId} onOpenMap={() => undefined} /></div>
    </div>
  </QueryClientProvider>,
); }
mountEditor();

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(100); }
  throw new Error('Fixture condition did not resolve');
}
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
function clickButton(text: string): void {
  const button = [...window.document.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === text || el.title === text || el.getAttribute('aria-label') === text);
  if (!button) throw new Error(`Missing diagram control: ${text}`);
  button.click();
}
async function runDiagramChecks(): Promise<string[]> {
  check(getComputedStyle(window.document.querySelector('.dg-sheet')!).backgroundColor === 'rgb(22, 22, 22)', 'Diagram sheet must match the dark Athena theme');
  check(window.document.querySelector('.dg-edge__line')?.getAttribute('stroke') === '#c6c6c6', 'Existing dark connectors remain visible on the dark sheet');
  check(snapshot.document.edges[0]?.stroke === '#333333', 'Editor theme must not mutate saved connector colours');
  await waitFor(() => window.document.querySelector('.dg-editor') !== null);
  const sheet = window.document.querySelector<SVGSVGElement>('svg.dg-canvas')!;
  const shape = window.document.querySelector<SVGGElement>(`g.dg-node[data-id="${workforce.id}"]`)!;
  const bounds = shape.getBoundingClientRect();
  const beforeDoubleClick = window.document.querySelectorAll('g.dg-node').length;
  sheet.dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
  }));
  await waitFor(() => window.document.querySelector('.dg-label-editor') !== null);
  check(window.document.querySelector<HTMLTextAreaElement>('.dg-label-editor')?.value === workforce.label,
    'Sheet-retargeted double-click edits the shape underneath');
  check(window.document.querySelectorAll('g.dg-node').length === beforeDoubleClick, 'Shape double-click cannot create another object');
  window.document.querySelector('.dg-label-editor')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => window.document.querySelector('.dg-label-editor') === null);
  clickButton('Link a note');
  await waitFor(() => window.document.querySelector('.dg-note-links__choice') !== null);
  clickButton('Process requirements');
  await waitFor(() => window.document.querySelector('.dg-note-links__row a') !== null);
  const noteLink = window.document.querySelector<HTMLAnchorElement>('.dg-note-links__row a')!;
  check(noteLink.getAttribute('href') === `/think?noteId=${noteId}`, 'Diagram must link back to its note');
  noteLink.click();
  check(openedNote === noteId, 'Linked note must open through Think navigation');
  await waitFor(() => window.document.querySelector('.mm-note-maps__name')?.textContent === 'Enterprise architecture / process flow');
  clickButton('Unlink Process requirements');
  await waitFor(() => window.document.querySelector('.dg-note-links__row') === null);
  clickButton('Link a note');
  await waitFor(() => window.document.querySelector('.dg-note-links__choice') !== null);
  clickButton('Process requirements');
  await waitFor(() => window.document.querySelector('.dg-note-links__row a') !== null);
  const svg = await diagramSvg(snapshot.document, assets, 'white');
  check(svg.includes('data:image/svg+xml;base64,'), 'SVG must embed icon bytes');
  check(svg.includes('Agent Runtime') && svg.includes('Approved?'), 'Architecture and flow labels must export');
  check(!svg.includes('blob:') && !svg.includes('href="https:'), 'Exports must be self-contained');
  check(svg.includes('marker-start='), 'Bidirectional arrows must export');
  const unsafeLabel = structuredClone(doc);
  unsafeLabel.nodes[0]!.label = '<script>alert("test")</script>';
  check(!(await diagramSvg(unsafeLabel, assets, 'transparent')).includes('<script>'), 'Labels must be XML escaped');
  const missingAsset = new Map<string, Blob>();
  let failed = false;
  try { await diagramSvg(doc, missingAsset, 'white'); } catch { failed = true; }
  check(failed, 'Missing export icons must fail explicitly');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => { resolve(); }; image.onerror = () => { reject(new Error('SVG export could not render')); }; image.src = url; });
    check(image.width > 800 && image.height > 600, 'Export must include full diagram bounds');
    const canvas = window.document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG export canvas unavailable');
    context.drawImage(image, 0, 0);
    check(canvas.toDataURL('image/png').startsWith('data:image/png;base64,'), 'Embedded SVG icons must allow PNG export');
  } finally { URL.revokeObjectURL(url); }
  const count = (): number => window.document.querySelectorAll('g.dg-node').length;
  const baseline = count();
  clickButton('Add Process');
  await waitFor(() => count() === baseline + 1);
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => count() === baseline);
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => count() === baseline + 1);
  const addedNode = [...window.document.querySelectorAll('g.dg-node')].at(-1)!;
  addedNode.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => window.document.querySelector('.dg-label-editor') !== null);
  const field = window.document.querySelector<HTMLTextAreaElement>('.dg-label-editor')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Browser-verified process');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await delay(20);
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => snapshot.document.nodes.some((n) => n.label === 'Browser-verified process'));
  const setThickness = async (label: string, width: number): Promise<void> => {
    const input = window.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(input, String(width));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await delay(20);
  };
  await setThickness('Border thickness', 3);
  await waitFor(() => snapshot.document.nodes.some(n => n.label === 'Browser-verified process' && n.strokeWidth === 3));
  const thickShape = snapshot.document.nodes.find(n => n.label === 'Browser-verified process')!;
  check(window.document.querySelector(`g.dg-node[data-id="${thickShape.id}"] .dg-node__body`)?.getAttribute('stroke-width') === '3',
    'Shape border thickness is rendered');
  for (const horizontal of ['Left', 'Center', 'Right']) {
    for (const vertical of ['Top', 'Middle', 'Bottom']) {
      const horizontalGroup = window.document.querySelector('[aria-label="Text horizontal alignment"]')!;
      [...horizontalGroup.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === horizontal)!.click();
      await delay(20);
      const verticalGroup = window.document.querySelector('[aria-label="Text vertical alignment"]')!;
      [...verticalGroup.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === vertical)!.click();
      await waitFor(() => snapshot.document.nodes.some(n => n.label === 'Browser-verified process'
        && n.textAlign === horizontal.toLowerCase() && n.textVerticalAlign === vertical.toLowerCase()));
      const aligned = snapshot.document.nodes.find(n => n.label === 'Browser-verified process')!;
      const rendered = window.document.querySelector(`g.dg-node[data-id="${aligned.id}"] text`)!;
      const anchor = horizontal === 'Left' ? 'start' : horizontal === 'Right' ? 'end' : 'middle';
      check(rendered.getAttribute('text-anchor') === anchor, 'Canvas reflects horizontal text alignment');
      const xml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
      const exported = [...xml.querySelectorAll('text')].find(text => text.textContent?.includes('Browser-verified'))!;
      check(exported.getAttribute('text-anchor') === anchor, 'Export reflects horizontal text alignment');
      check(exported.querySelector('tspan')?.getAttribute('y') === rendered.querySelector('tspan')?.getAttribute('y'),
        'Canvas and export share vertical text position');
    }
  }
  const setProperty = async (label: string, value: string): Promise<void> => {
    const input = window.document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
    check(input !== null, `Missing property field: ${label}`);
    input!.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(20);
    input!.blur();
  };
  await setProperty('Shape or connector description', 'Process owner: Operations\nOutput: approved request');
  await waitFor(() => snapshot.document.nodes.some((n) => n.description?.includes('Process owner: Operations') === true));
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => !snapshot.document.nodes.some((n) => n.description?.includes('Process owner: Operations') === true));
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => snapshot.document.nodes.some((n) => n.description?.includes('Process owner: Operations') === true));
  const connector = window.document.querySelector('g.dg-edge')!;
  connector.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
  await waitFor(() => window.document.querySelector('.dg-properties__kind')?.textContent === 'Connector');
  for (const width of [0.5, 1.5, 4, 6]) {
    await setThickness('Line thickness', width);
    await waitFor(() => snapshot.document.edges[0]?.strokeWidth === width);
    const line = window.document.querySelector<SVGPathElement>(`g.dg-edge[data-id="${snapshot.document.edges[0]!.id}"] .dg-edge__line`)!;
    check(Number(getComputedStyle(line).strokeWidth.replace('px', '')) === width, 'Connector thickness is not overridden by CSS');
    const markerId = line.getAttribute('marker-end')!.slice(5, -1);
    const marker = window.document.getElementById(markerId)!;
    check(marker.getAttribute('markerUnits') === 'strokeWidth', 'Arrowheads scale with connector stroke');
    check(Math.abs(Number(marker.getAttribute('markerWidth')) * width - 10 * width / 1.5) < 0.001,
      'Arrow size scales proportionally and preserves original size at 1.5 px');
    const xml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
    check(xml.querySelector('polyline')?.getAttribute('stroke-width') === String(width), 'Exports preserve connector thickness');
    check(xml.querySelector('marker')?.getAttribute('markerUnits') === 'strokeWidth', 'Export arrowheads scale with line thickness');
  }
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => snapshot.document.edges[0]?.strokeWidth === 4);
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => snapshot.document.edges[0]?.strokeWidth === 6);
  await setProperty('Shape or connector title', 'Request handoff');
  await setProperty('Shape or connector description', 'Passes the request to the runtime.');
  await waitFor(() => snapshot.document.edges.some((e) => e.label === 'Request handoff' && e.description === 'Passes the request to the runtime.'));
  const processId = snapshot.document.nodes.find((n) => n.label === 'Browser-verified process')!.id;
  const process = window.document.querySelector(`g.dg-node[data-id="${processId}"]`)!;
  process.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => window.document.querySelector('.dg-label-editor') !== null);
  window.document.querySelector('.dg-label-editor')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(20);
  clickButton('Duplicate (Ctrl+D)');
  await waitFor(() => count() === baseline + 2);
  await waitFor(() => snapshot.document.nodes.length === baseline + 2);
  const editor = window.document.querySelector<HTMLElement>('.dg-editor')!;
  const clipboard = new DataTransfer();
  clipboard.items.add(new File([icon], 'clipboard.svg', { type: 'image/svg+xml' }));
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  await waitFor(() => snapshot.document.nodes.filter((n) => n.kind === 'image').length === 2);
  const links = new DataTransfer();
  links.setData('text/plain', 'https://example.com/icon.svg');
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: links, bubbles: true, cancelable: true }));
  await waitFor(() => window.document.body.innerText.includes('download the image and upload it'));
  conflict = true;
  clickButton('Add Decision');
  await waitFor(() => window.document.querySelector('.dg-status--conflict') !== null);
  const localCount = count();
  check(localCount > snapshot.document.nodes.length, 'Conflicting edits must remain locally visible');
  conflict = false;
  clickButton('Keep my version');
  await waitFor(() => snapshot.document.nodes.length === localCount && window.document.querySelector('.dg-status--saved') !== null);
  clickButton('Add image or icon');
  await waitFor(() => window.document.querySelector('.dg-icons') !== null);
  clickButton('Microsoft icons');
  await waitFor(() => window.document.querySelectorAll('.dg-icons__grid button').length === 46);
  window.document.querySelector<HTMLButtonElement>('.dg-icons__grid button')!.click();
  await waitFor(() => snapshot.document.nodes.filter((n) => n.kind === 'image').length === 3);
  check((await diagramSvg(snapshot.document, assets, 'white')).match(/data:image\/svg\+xml;base64,/g)?.length === 3, 'Library and pasted icons must all be embedded in exports');
  const saved = structuredClone(snapshot);
  root.render(null);
  await waitFor(() => window.document.querySelector('.dg-editor') === null);
  queryClient.clear();
  mountEditor();
  await waitFor(() => count() === saved.document.nodes.length);
  await waitFor(() => window.document.querySelector('.dg-note-links__row a') !== null);
  check(snapshot.document.nodes.some((n) => n.label === 'Browser-verified process'), 'Saved labels must survive reopening');
  check(snapshot.document.nodes.some(n => n.label === 'Browser-verified process' && n.textAlign === 'right' && n.textVerticalAlign === 'bottom'),
    'Text alignment survives reopening and duplication');
  check(snapshot.document.nodes.some((n) => n.description?.includes('Process owner: Operations') === true), 'Shape descriptions must survive reopening and duplication');
  check(snapshot.document.edges.some((e) => e.description === 'Passes the request to the runtime.'), 'Connector descriptions must survive reopening');
  check(snapshot.document.edges[0]?.strokeWidth === 6, 'Connector thickness survives reopening');
  check(snapshot.document.nodes.some(n => n.label === 'Browser-verified process' && n.strokeWidth === 3),
    'Shape thickness survives reopening and duplication');
  check(!(await diagramSvg(snapshot.document, assets, 'white')).includes('Process owner: Operations'), 'Descriptions must not clutter visual exports');
  await waitFor(() => window.document.querySelectorAll('g.dg-node--image image').length === 3);
  root.render(null);
  await waitFor(() => window.document.querySelector('.dg-editor') === null);
  missingDiagram = true;
  mountEditor();
  await waitFor(() => window.document.querySelector('.dg-editor[role="alert"]') !== null);
  check(count() === 0 && window.document.body.innerText.includes('Diagram not found'), 'Missing diagrams must show an error, not a saved blank drawing');
  check(window.document.documentElement.scrollWidth <= innerWidth + 1, 'No page horizontal overflow');
  const { checkDiagramFromNote } = await import('./diagramNoteCreation.browser');
  await checkDiagramFromNote(queryClient, waitFor);
  return ['Representative architecture and process flow render', 'SVG export full bounds, embedded icon and bidirectional arrows',
    'PNG rasterisation with embedded SVG icon', 'Escaped labels and explicit missing-asset errors',
    'Shape double-click edits instead of adding', 'All nine text alignments match canvas and export',
    'Line and border thickness persist, undo/redo and scale exported arrowheads',
    'Add, label editing, undo/redo and duplication', 'Image-file clipboard paste and explicit URL-only fallback',
    'Save conflict retains local changes and explicit overwrite resolves it',         'Shape and connector properties save/reopen, undo/redo and duplicate without cluttering exports',
    'Note linking, return links in Connections, opening/unlinking and reopening',
    'Create diagram from a note saves pending edits and blocks navigation on save failure',
    'Bundled Microsoft icon picker loads and embeds an official icon', 'Save and reopen retain labels and icons',
    'Missing diagram displays an explicit load error', 'No horizontal page overflow'];
}
Object.assign(window, { runDiagramChecks, diagramFixture: {
  snapshot: () => structuredClone(snapshot), saves: () => saves, conflict: (value: boolean) => { conflict = value; },
  waitFor, clickButton,
} });
