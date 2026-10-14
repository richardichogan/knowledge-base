import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DiagramEditor } from '../src/features/diagram/DiagramEditor';
import { api } from '../src/services/api';
import type { ApiResponse } from '../src/types';
import { emptyDiagram, type DiagramDocument, type DiagramNode, type DiagramSnapshot } from '../src/features/diagram/diagramTypes';
import { diagramSvg } from '../src/features/diagram/diagramExport';
import { footnoteBlock } from '../src/features/diagram/diagramAnnotations';
import { diagramBounds, documentWaveDepth, edgeEndpoints, lineGeometry, linePoints, portPoint } from '../src/features/diagram/diagramGeometry';
import { DIAGRAM_CALLOUT_TYPES } from '../src/features/diagram/diagramTypes';
import { calloutLayout, DIAGRAM_CALLOUTS } from '../src/features/diagram/diagramCallouts';
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
const children = new Map<string, DiagramSnapshot>();
const drilldownLinks = new Map<string, { nodeId: string; canvasId: string; title: string }>();
let failDrilldown = false;
let failChildSave = false;
let drilldownRequests = 0;
let missingDiagram = false;
const noteId = crypto.randomUUID();
let linkedNotes: Array<{ id: string; title: string }> = [];
let openedNote: string | null = null;
api.getDiagram = async (id) => {
  if (id !== canvasId) return success(structuredClone(children.get(id)!));
  if (missingDiagram) throw Object.assign(new Error('Diagram not found'), { isAxiosError: true, response: { status: 404 } });
  return success(structuredClone(snapshot));
};
api.getCanvas = async (id) => success({
  id, title: id === canvasId ? 'Enterprise architecture / process flow' : 'Runtime internals', canvasType: 'diagram',
  description: null, project: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  linkedNotes, nodeCount: snapshot.document.nodes.length, nodes: [], edges: [], viewport: snapshot.document.viewport,
});
api.saveDiagram = async (_id, revision, document) => {
  if (_id !== canvasId) {
    if (failChildSave) throw new Error('Child save unavailable');
    const current = children.get(_id)!;
    if (current.revision !== revision) throw new Error('Child revision mismatch');
    const saved = { revision: revision + 1, document: structuredClone(document) };
    children.set(_id, saved);
    return success(structuredClone(saved));
  }
  if (conflict || revision !== snapshot.revision) throw Object.assign(new Error('Another session updated this diagram'), { isAxiosError: true, response: { status: 409 } });
  snapshot = { revision: revision + 1, document: structuredClone(document) }; saves++;
  return success(structuredClone(snapshot));
};
api.listDiagramDrilldowns = async id => success([...drilldownLinks.entries()]
  .filter(([key]) => key.startsWith(`${id}:`)).map(([, link]) => link));
api.openDiagramDrilldown = async (id, nodeId, revision) => {
  drilldownRequests++;
  if (failDrilldown) throw new Error('Drill-down unavailable');
  const current = id === canvasId ? snapshot : children.get(id)!;
  check(current.revision === revision, 'Drill-down opens against the saved revision');
  check(current.document.nodes.some(node => node.id === nodeId), 'New shape saves before creating its drill-down');
  const key = `${id}:${nodeId}`;
  if (!drilldownLinks.has(key)) {
    const childId = crypto.randomUUID();
    children.set(childId, { revision: 0, document: emptyDiagram() });
    drilldownLinks.set(key, { nodeId, canvasId: childId, title: 'Runtime internals' });
  }
  return success(drilldownLinks.get(key)!);
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
let athenaLinkedId: string | null = null;
api.getSessionIdForNote = async id => { athenaLinkedId = id; return success({ sessionId: null }); };
api.getProjects = async () => success([]);
api.listModelChoices = async () => success([]);
api.summarizeNote = async () => success({ summary: 'Diagram fixture context.' });
let submittedChat = false;
let finishChat: (() => void) | undefined;
api.startChatTurn = async () => {
  submittedChat = true;
  return new Promise(resolve => {
    finishChat = () => { resolve({ success: false, error: { code: 'FIXTURE', message: 'Isolated fixture finished.' } }); };
  });
};

const root = createRoot(window.document.getElementById('root')!);
function mountEditor(): void { root.render(
  <MemoryRouter><QueryClientProvider client={queryClient}>
    <div className="kh-content" style={{ height: '100vh', padding: '24px' }}>
      <div className="notes-editor-area notes-editor-area--map" style={{ height: '100%' }}>
        <DiagramEditor canvasId={canvasId} onDeleted={() => undefined} onOpenNote={(id) => { openedNote = id; }} />
      </div>
      <div hidden><NoteMaps noteId={noteId} onOpenMap={() => undefined} /></div>
    </div>
  </QueryClientProvider></MemoryRouter>,
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
async function runDiagramLineJumpChecks(): Promise<string[]> {
  root.render(null);
  await delay(100);
  queryClient.clear();
  const left = node('Source', 'process', 20, 160, 60, 40);
  const right = node('Target', 'process', 460, 160, 60, 40);
  const top = node('Top', 'process', 240, 20, 60, 40);
  const bottom = node('Bottom', 'process', 240, 300, 60, 40);
  const under = { ...node('', 'line', 0, 0, 24, 24), ...lineGeometry({ x: 100, y: 240 }, { x: 420, y: 240 }) };
  const over = { ...node('', 'line', 0, 0, 24, 24), ...lineGeometry({ x: 160, y: 120 }, { x: 160, y: 300 }),
    stroke: '#0f62fe', strokeStyle: 'dotted' as const, strokeWidth: 4 };
  const crossing = { ...emptyDiagram(), nodes: [left, right, top, bottom, under, over], edges: [
    { ...doc.edges[0]!, id: crypto.randomUUID(), sourceId: left.id, targetId: right.id, arrows: 'end' as const, label: '' },
    { ...doc.edges[0]!, id: crypto.randomUUID(), sourceId: top.id, targetId: bottom.id,
      sourcePort: 'bottom' as const, targetPort: 'top' as const, stroke: '#0f62fe', dashed: true, arrows: 'both' as const, label: '' },
  ] };
  snapshot = { revision: 0, document: structuredClone(crossing) };
  mountEditor();
  await waitFor(() => window.document.querySelectorAll('.dg-edge__line').length === 2);
  clickButton('Fit diagram to view');
  const standalone = (): SVGPathElement | null =>
    window.document.querySelector(`g.dg-node[data-id="${over.id}"] path.dg-node__body`);
  const edge = (): SVGPathElement => window.document.querySelector(`g.dg-edge[data-id="${crossing.edges[1]!.id}"] .dg-edge__line`)!;
  await waitFor(() => standalone() !== null && edge().getAttribute('d')!.includes(' A'));
  const arcCount = (d: string): number => (d.match(/ A/g) ?? []).length;
  check(arcCount(standalone()!.getAttribute('d')!) === 1, 'Standalone lines form a single curved bridge');
  check(arcCount(edge().getAttribute('d')!) === 2, 'Connector bridges both standalone and connector crossings');
  check(standalone()!.getAttribute('stroke-dasharray') !== null, 'Dotted strokes survive bridging');
  check(edge().getAttribute('stroke-dasharray') === '6 4' && edge().hasAttribute('marker-start') && edge().hasAttribute('marker-end'),
    'Connector dashes and both arrowheads survive bridging');
  check(window.document.querySelector(`g.dg-node[data-id="${under.id}"] line.dg-node__body`) !== null,
    'Earlier painted line remains straight');
  for (const background of ['white', 'transparent'] as const) {
    const xml = new DOMParser().parseFromString(await diagramSvg(crossing, new Map(), background), 'image/svg+xml');
    check(xml.querySelector('parsererror') === null, 'Bridge export is valid SVG');
    check([...xml.querySelectorAll('path')].some(path => path.getAttribute('d') === standalone()!.getAttribute('d')),
      'Standalone bridge is identical in canvas and export');
    check([...xml.querySelectorAll('path')].some(path => path.getAttribute('d') === edge().getAttribute('d')),
      'Connector bridge is identical in canvas and export');
  }
  check(window.document.querySelector(`g.dg-node[data-id="${over.id}"] .dg-line__hit`)!.getAttribute('d') === standalone()!.getAttribute('d'),
    'Standalone bridge hit target follows the visible arch');
  const group = edge().closest('g.dg-edge')!;
  check(group.querySelector('.dg-edge__hit')!.getAttribute('d') === edge().getAttribute('d')
    && group.querySelector('.dg-edge__halo')!.getAttribute('d') === edge().getAttribute('d'),
  'Connector hit target and selection halo follow the bridge');
  check(window.document.querySelector(`g.dg-node[data-id="${under.id}"] .dg-node__body`)!.hasAttribute('mask'),
    'Earlier strokes are masked beneath the arch without covering the grid or shapes');
  const rasterDocument = { ...emptyDiagram(), nodes: [
    { ...under, stroke: '#161616', ...lineGeometry({ x: 0, y: 50 }, { x: 100, y: 50 }), strokeWidth: 1.5 },
    { ...over, strokeStyle: 'solid' as const, ...lineGeometry({ x: 50, y: 0 }, { x: 50, y: 100 }), strokeWidth: 1.5 },
  ] };
  for (const background of ['white', 'transparent'] as const) {
    const svg = await diagramSvg(rasterDocument, new Map(), background);
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const [vx, vy, width, height] = parsed.getAttribute('viewBox')!.split(' ').map(Number);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Bridge SVG rasterization failed'));
        image.src = url;
      });
      const raster = window.document.createElement('canvas');
      raster.width = width!; raster.height = height!;
      const context = raster.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const gap = context.getImageData(57 - vx!, 50 - vy!, 1, 1).data;
      check(background === 'transparent' ? gap[3] === 0 : gap[0] === 255 && gap[1] === 255 && gap[2] === 255,
        'PNG rasterization leaves a true transparent/white gap beneath the bridge, not a joined crossing');
      const ink = context.getImageData(56 - vx!, 50 - vy!, 1, 1).data;
      check(ink[2]! > ink[0]! && ink[3]! > 0, 'PNG rasterization retains the blue overpassing arc');
    } finally { URL.revokeObjectURL(url); }
  }
  await waitFor(() => window.document.querySelector('.dg-status--saved') !== null);
  check(window.document.documentElement.scrollWidth <= window.innerWidth, 'Crossing diagrams do not overflow the page');
  return ['Automatic hops distinguish connector and standalone-line crossings',
    'SVG/PNG-source paths match the editor on white and transparent backgrounds',
    'Bridge hit targets and transparent knockout masks follow the visible arches',
    'Dotted/dashed strokes, arrowheads and responsive layout are preserved'];
}
async function runDiagramPropertiesChecks(): Promise<string[]> {
  await waitFor(() => window.document.querySelector('select[aria-label="Diagram project"]') !== null);
  const properties = window.document.querySelector<HTMLElement>('.dg-properties')!;
  const projectSelect = properties.querySelector<HTMLSelectElement>('select[aria-label="Diagram project"]')!;
  function checkPropertiesFit(): void {
    const overflow = [...properties.querySelectorAll<HTMLElement>('input, textarea, select')]
      .map(control => `${control.getAttribute('aria-label')}: ${Math.round(control.getBoundingClientRect().width)}px (${getComputedStyle(control).boxSizing})`)
      .join(', ');
    check(properties.scrollWidth <= properties.clientWidth,
      `Properties panel must not scroll horizontally (${properties.scrollWidth}/${properties.clientWidth}; ${overflow})`);
    for (const control of properties.querySelectorAll<HTMLElement>('input, textarea, select')) {
      check(control.getBoundingClientRect().right <= properties.getBoundingClientRect().right,
        `${control.getAttribute('aria-label')} fits inside Properties`);
    }
  }
  checkPropertiesFit();
  const longProject = new Option('IMAGINE - Agentic Enterprise Architecture and Implementation Programme', 'long-project');
  projectSelect.add(longProject);
  longProject.selected = true;
  await delay(50);
  checkPropertiesFit();
  longProject.remove();
  const originalHeight = properties.style.maxHeight;
  properties.style.maxHeight = '120px';
  await delay(50);
  checkPropertiesFit();
  check(properties.scrollHeight > properties.clientHeight && getComputedStyle(properties).overflowY === 'auto',
    'Overflowing Properties content retains vertical scrolling');
  properties.scrollTop = properties.scrollHeight;
  check(properties.scrollTop > 0, 'Properties can still be scrolled vertically');
  properties.style.maxHeight = originalHeight;
  properties.scrollTop = 0;
  return ['Properties controls fit without horizontal scrolling, including long project names',
    'Vertical scrolling remains available when Properties content exceeds the panel height'];
}
async function runDiagramDrilldownChecks(): Promise<string[]> {
      await waitFor(() => window.document.querySelector('.dg-editor') !== null);
      const parent = window.document.querySelector<HTMLElement>('.dg-editor')!;
      const selectShape = (root: Element, id: string): void => {
        root.querySelector(`g.dg-node[data-id="${id}"]`)!.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, pointerId: 1,
        }));
        root.querySelector('svg.dg-canvas')!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      };
      const findButton = (root: Element, label: string): HTMLButtonElement =>
        [...root.querySelectorAll<HTMLButtonElement>('button')].find(button =>
          button.textContent?.trim() === label || button.getAttribute('aria-label') === label)!;
      const activeDialog = (): HTMLDialogElement => [...window.document.querySelectorAll<HTMLDialogElement>('dialog.dg-drilldown[open]')].at(-1)!;
      const clickDrilldown = async (root: Element, label: string): Promise<void> => {
        await waitFor(() => findButton(root, label)?.disabled === false);
        findButton(root, label).click();
      };
      selectShape(parent, workforce.id);
      await waitFor(() => findButton(parent, 'Add drill-down diagram')?.disabled === false);
      await waitFor(() => parent.querySelector('.dg-status--saved') !== null);
      const beforeParent = structuredClone(snapshot);
      failDrilldown = true;
      await clickDrilldown(parent, 'Add drill-down diagram');
      await waitFor(() => parent.textContent?.includes('Drill-down unavailable') === true);
      check(window.document.querySelector('dialog.dg-drilldown') === null, 'Failed creation never opens an empty success popup');
      failDrilldown = false;
      const requestCount = drilldownRequests;
      const add = findButton(parent, 'Add drill-down diagram');
      add.click(); add.click();
      await waitFor(() => window.document.querySelector('dialog.dg-drilldown[open] .dg-canvas') !== null);
      check(drilldownRequests === requestCount + 1, 'Double click creates only one detail diagram');
      const first = activeDialog();
      await waitFor(() => first.querySelector('.dg-status--saved') !== null);
      check(first.querySelector('h2')?.textContent === 'Workforce agents', 'Popup identifies the parent shape');
      check(first.querySelector('.dg-drilldown__context p')?.textContent?.includes('Enterprise architecture') === true, 'Parent context remains visible');
      check(first.scrollWidth <= first.clientWidth && window.document.documentElement.scrollWidth <= innerWidth + 1, 'Drill-down fits desktop and narrow screens');
      check(first.contains(window.document.activeElement), 'Focus enters the modal');
      findButton(first, 'Add Process').click();
      await waitFor(() => first.querySelectorAll('g.dg-node').length === 1);
      const childId = drilldownLinks.get(`${canvasId}:${workforce.id}`)!.canvasId;
      const childShape = first.querySelector<SVGGElement>('g.dg-node')!.dataset.id!;
      failChildSave = true;
      findButton(first, 'Close drill-down').click();
      await waitFor(() => first.querySelector('.dg-drilldown__error') !== null);
      check(first.open && first.querySelectorAll('g.dg-node').length === 1, 'Failed close-save retains the open detail and its writing');
      failChildSave = false;
      findButton(first, 'Retry').click();
      await waitFor(() => first.querySelector('.dg-status--saved') !== null);
      await clickDrilldown(first, 'Add drill-down diagram');
      await waitFor(() => window.document.querySelectorAll('dialog.dg-drilldown[open]').length === 2);
      const second = activeDialog();
      await waitFor(() => second.querySelector('svg.dg-canvas') !== null);
      findButton(second, 'Add Process').click();
      await waitFor(() => second.querySelectorAll('g.dg-node').length === 1);
      findButton(second, 'Close drill-down').click();
      await waitFor(() => window.document.querySelectorAll('dialog.dg-drilldown[open]').length === 1);
      check(children.get(drilldownLinks.get(`${childId}:${childShape}`)!.canvasId)?.document.nodes.length === 1,
        'Nested drill-down saves before returning one level');
      check(first.open && first.querySelectorAll('g.dg-node').length === 1, 'Returning leaves the immediate parent intact');
      const childRoot = first.querySelector<HTMLElement>('.dg-editor')!;
      childRoot.focus();
      childRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await waitFor(() => first.querySelectorAll('g.dg-node').length === 0);
      check(snapshot.document.nodes.length === beforeParent.document.nodes.length, 'Child keyboard deletion never affects the outer diagram');
      childRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await waitFor(() => first.querySelectorAll('g.dg-node').length === 1);
      first.dispatchEvent(new Event('cancel', { cancelable: true }));
      await waitFor(() => window.document.querySelector('dialog.dg-drilldown') === null);
      check(children.get(childId)?.document.nodes.length === 1, 'Escape saves the detail diagram before closing');
      check(JSON.stringify(snapshot) === JSON.stringify(beforeParent), 'Parent document, selection and viewport are untouched');
      check(parent.querySelector(`g.dg-node[data-id="${workforce.id}"]`)?.classList.contains('dg-node--selected') === true, 'Parent selection survives drill-down');
      await waitFor(() => parent.querySelector('.dg-drilldown-marker') !== null);
      const marker = parent.querySelector<SVGGElement>('.dg-drilldown-marker')!;
      marker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await waitFor(() => window.document.querySelector('dialog.dg-drilldown[open] g.dg-node') !== null);
      check(children.size === 2 && activeDialog().querySelectorAll('g.dg-node').length === 1, 'Marker reopens saved detail without creating another canvas');
      return ['Creation errors are explicit; duplicate opens are guarded', 'Editable nested diagrams persist and reopen from a shape marker',
        'Save failure blocks closing without losing changes; retry succeeds', 'Nested navigation, Escape, focus and keyboard editing are isolated',
        'Parent selection, document and viewport remain intact', 'Popup fits desktop and mobile'];
}
async function runDiagramChecks(): Promise<string[]> {
  check(getComputedStyle(window.document.querySelector('.dg-sheet')!).backgroundColor === 'rgb(22, 22, 22)', 'Diagram sheet must match the dark Athena theme');
  check(window.document.querySelector('.dg-edge__line')?.getAttribute('stroke') === '#c6c6c6', 'Existing dark connectors remain visible on the dark sheet');
  check(snapshot.document.edges[0]?.stroke === '#333333', 'Editor theme must not mutate saved connector colours');
  await waitFor(() => window.document.querySelector('.dg-editor') !== null);
  clickButton('Athena');
  await waitFor(() => window.document.querySelector('.dg-athena .think-athena-panel') !== null);
  await waitFor(() => athenaLinkedId === `map:${canvasId}`);
  check(window.document.querySelector('.dg-athena')?.textContent?.includes('Enterprise architecture / process flow') === true,
    'Athena receives the current diagram context and linked conversation');
  check(window.document.documentElement.scrollWidth <= innerWidth + 1, 'Diagram Athena panel must not overflow on mobile');
  const composer = window.document.querySelector<HTMLTextAreaElement>('.dg-athena textarea');
  check(composer !== null && composer.getBoundingClientRect().height > 0, 'Athena composer must be visible on desktop and mobile');
  const sendFixturePrompt = async (text: string): Promise<void> => {
    submittedChat = false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, text);
    composer!.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(50);
    composer!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    await waitFor(() => submittedChat);
    await delay(150);
  };
  const messagesBox = window.document.querySelector<HTMLElement>('.dg-athena .ai-messages')!;
  await sendFixturePrompt('What are your thoughts on this?');
  check(messagesBox.scrollHeight <= messagesBox.clientHeight, 'Short prompt plus thinking status must not create a scrollbar');
  check(getComputedStyle(window.document.querySelector('.ai-prompt-room')!).display === 'none',
    'Prompt spacer stays hidden while real content fits');
  messagesBox.style.maxHeight = '40px';
  await waitFor(() => messagesBox.clientHeight <= 40 && messagesBox.scrollHeight > messagesBox.clientHeight);
  messagesBox.style.maxHeight = '';
  await waitFor(() => messagesBox.scrollHeight <= messagesBox.clientHeight);
  check(getComputedStyle(window.document.querySelector('.ai-prompt-room')!).display === 'none',
    'Growing the panel removes the scroll range again when the conversation fits');
  finishChat!();
  await waitFor(() => !composer!.disabled);
  await sendFixturePrompt('A long conversation must remain scrollable. '.repeat(100));
  check(messagesBox.scrollHeight > messagesBox.clientHeight, 'Long real conversation requires a scroll range');
  check(getComputedStyle(messagesBox).overflowY === 'auto', 'Scrollbar remains automatic for overflowing content');
  messagesBox.scrollTop = messagesBox.scrollHeight;
  check(messagesBox.scrollTop > 0, 'Overflowing conversation remains scrollable');
  finishChat!();
  await waitFor(() => !composer!.disabled);
  clickButton('Close Athena');
  await waitFor(() => window.document.querySelector('.dg-properties') !== null);
  await runDiagramPropertiesChecks();
  check(window.document.querySelector('.dg-athena')?.hasAttribute('hidden') === true,
    'Closing Athena preserves the mounted chat so ongoing turns and drafts are retained');
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
  clickButton('Add footnote');
  await waitFor(() => window.document.querySelector('g.dg-marker') !== null && window.document.querySelector('svg.dg-canvas .dg-noteblock') !== null);
  await waitFor(() => snapshot.document.footnotes?.[0]?.targetId === workforce.id);
  check(window.document.querySelector('.dg-footnotes') === null, 'Footnotes are drawn on the diagram, not in a separate pane');
  check(window.document.querySelector('a.dg-noteblock__item')?.getAttribute('href')?.includes('footnote=1') === true, 'Footnote number links to its note');
  check(window.document.querySelector(`g.dg-node[data-id="${workforce.id}"]`)?.classList.contains('dg-node--selected') === true,
    'New footnote keeps its shape selected');
  check(window.document.querySelector('.dg-noteblock__item')?.textContent?.includes(workforce.label) === true, 'Note shows the shape title');
  const markerBox = window.document.querySelector('g.dg-node[data-id="' + workforce.id + '"]')!.getBoundingClientRect();
  const blockBox = window.document.querySelector('.dg-noteblock__frame')!.getBoundingClientRect();
  const frameStyle = getComputedStyle(window.document.querySelector('.dg-noteblock__frame')!);
  check(frameStyle.fill === 'none' && frameStyle.stroke === 'none', 'Footnote area is transparent and borderless');
  const divider = window.document.querySelector('.dg-noteblock__divider')!;
  const dividerStyle = getComputedStyle(divider);
  check(dividerStyle.strokeDasharray === '6px, 6px' && dividerStyle.strokeWidth === '1px'
    && dividerStyle.pointerEvents === 'none', 'Notes divider is thin, dashed and non-interactive');
  check(Number(divider.getAttribute('y1')) < Number(window.document.querySelector('.dg-noteblock__heading')!.getAttribute('y')),
    'Divider sits above the Notes heading');
  const contentBounds = diagramBounds(snapshot.document, 0);
  check(Number(divider.getAttribute('x1')) === contentBounds.x
    && Number(divider.getAttribute('x2')) === contentBounds.x + contentBounds.width,
    'Notes divider spans the actual diagram, independently of canvas or notes width');
  const columnNodes = Array.from({ length: 9 }, (_, i) => ({
    ...workforce, id: crypto.randomUUID(), parentId: null, label: `Footnote column ${i + 1}`, description: `Detail ${i + 1}`,
  }));
  const columnDoc: DiagramDocument = { ...snapshot.document, nodes: columnNodes, edges: [],
    footnotes: columnNodes.map(n => ({ id: crypto.randomUUID(), targetId: n.id, source: 'description' })) };
  const columnLayout = footnoteBlock(columnDoc, { x: 0, y: 0, width: 500, height: 200 }, 'bottom')!;
  check(columnLayout.items[4]!.marker.x > columnLayout.items[3]!.marker.x
    && columnLayout.items[4]!.marker.y === columnLayout.items[0]!.marker.y
    && columnLayout.items[8]!.marker.x > columnLayout.items[4]!.marker.x,
    'Footnotes five and nine start new columns');
  const columnExport = new DOMParser().parseFromString(await diagramSvg(columnDoc, new Map(), 'transparent'), 'image/svg+xml');
  const exportedTitles = [...columnExport.querySelectorAll('tspan[font-weight="600"]')].filter(t => t.textContent?.startsWith('Footnote column'));
  check(exportedTitles.length === 9 && exportedTitles[4]!.getAttribute('x') !== exportedTitles[0]!.getAttribute('x')
    && exportedTitles[4]!.getAttribute('y') === exportedTitles[0]!.getAttribute('y'),
    'SVG export retains the four-notes-per-column layout');
  check(![...columnExport.querySelectorAll('rect')].some(r => r.getAttribute('stroke') === '#c6c6c6'),
    'SVG export has no footnote frame');
  const exportedDivider = columnExport.querySelector('line[stroke-dasharray="6 6"]')!;
  const exportedContent = diagramBounds(columnDoc, 0);
  check(exportedDivider !== null && Number(exportedDivider.getAttribute('x1')) === exportedContent.x
    && Number(exportedDivider.getAttribute('x2')) === exportedContent.x + exportedContent.width
    && Number(exportedDivider.getAttribute('y1')) < Number([...columnExport.querySelectorAll('text')].find(t => t.textContent === 'Notes')!.getAttribute('y')),
    'Export divider uses diagram width even when the notes have more columns');
  check(blockBox.top > markerBox.bottom, 'Notes sit beneath the diagram by default');
  clickButton('Notes right');
  await waitFor(() => snapshot.document.notesPanel === 'right');
  await waitFor(() => window.document.querySelector('.dg-noteblock__frame')!.getBoundingClientRect().left > markerBox.right);
  const exportedNotes = await diagramSvg(snapshot.document, new Map(), 'white', false, { tolerateMissingAssets: true });
  check(exportedNotes.includes('>Notes<'), 'Export includes the notes block');
  clickButton('Notes below');
  await waitFor(() => snapshot.document.notesPanel === 'bottom');
  clickButton('Show colour key');
  await waitFor(() => window.document.querySelectorAll('.dg-legend__row').length > 0);
  window.document.querySelector<HTMLButtonElement>('.dg-legend__item')!.click();
  await waitFor(() => window.document.querySelector('g.dg-node--dimmed') !== null || window.document.querySelectorAll('.dg-legend__row').length === 1);
  window.document.querySelector<HTMLButtonElement>('.dg-legend__item')!.click();
  await waitFor(() => window.document.querySelector('g.dg-node--dimmed') === null);
  clickButton('Present');
  await waitFor(() => window.document.querySelector('.dg-present') !== null && window.document.querySelector('.dg-editor--presenting') !== null);
  check(window.document.querySelector('.dg-present__step')?.textContent?.startsWith('Note 1') === true, 'Presentation walks footnotes in order');
  clickButton('Exit (Esc)');
  await waitFor(() => window.document.querySelector('.dg-present') === null);
  clickButton('Hide colour key');
  window.document.querySelector('.dg-noteblock__hit')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
  await waitFor(() => window.document.querySelector('.dg-footnote-controls') !== null);
  check(window.document.querySelector(`g.dg-node[data-id="${workforce.id}"]`)?.classList.contains('dg-node--selected') === true,
    'Clicking a note selects its shape');
  clickButton('Remove footnote 1');
  await waitFor(() => window.document.querySelector('g.dg-marker') === null && window.document.querySelector('.dg-noteblock') === null && (snapshot.document.footnotes ?? []).length === 0);
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
  for (const end of [{ x: 200, y: 50 }, { x: 50, y: 200 }, { x: -50, y: 150 }]) {
    const start = { x: 50, y: 50 };
    const standalone: DiagramNode = { ...node('', 'line', 0, 0, 24, 24), ...lineGeometry(start, end),
      strokeWidth: 4, strokeStyle: 'dotted', fill: 'none' };
    check(JSON.stringify(linePoints(standalone)) === JSON.stringify([start, end]), 'Standalone line geometry preserves exact endpoints');
    const lineXml = new DOMParser().parseFromString(await diagramSvg({ ...doc, nodes: [standalone], edges: [] }, assets, 'white'), 'image/svg+xml');
    const exportedLine = lineXml.querySelector('g line')!;
    check(exportedLine.getAttribute('stroke-width') === '4' && exportedLine.getAttribute('stroke-dasharray') === '0 12',
      'Standalone lines export thickness and dotted style');
    check(!exportedLine.hasAttribute('marker-end') && !exportedLine.hasAttribute('marker-start'),
      'Standalone lines export without arrows');
  }
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
  const existingNodeIds = new Set(snapshot.document.nodes.map(n => n.id));
  clickButton('Add Process');
  await waitFor(() => count() === baseline + 1);
  await waitFor(() => snapshot.document.nodes.length === baseline + 1);
  check(snapshot.document.nodes.find(n => !existingNodeIds.has(n.id))?.fontSize === 16,
    'New shape labels default to 16 px');
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => count() === baseline);
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => count() === baseline + 1);
  const addedNode = [...window.document.querySelectorAll('g.dg-node')]
    .find(n => !existingNodeIds.has(n.getAttribute('data-id') ?? ''))!;
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
  const borderColours = window.document.querySelector('[aria-label="Border colour"]')!;
  borderColours.querySelector<HTMLButtonElement>('[aria-label="#da1e28"]')!.click();
  await waitFor(() => snapshot.document.nodes.some(n => n.id === thickShape.id && n.stroke === '#da1e28'));
  const backgrounds = window.document.querySelector('[aria-label="Background colour"]')!;
  check(backgrounds.querySelectorAll('button').length === 5, 'Background choices stay minimal');
  for (const fill of ['#262626', '#1c2d4a', '#173b27', '#3d3215', 'none', '#1c2d4a']) {
    backgrounds.querySelector<HTMLButtonElement>(`[aria-label="${fill === 'none' ? 'None' : fill}"]`)!.click();
    await waitFor(() => snapshot.document.nodes.some(n => n.id === thickShape.id && n.fill === fill));
    check(window.document.querySelector(`g.dg-node[data-id="${thickShape.id}"] .dg-node__body`)?.getAttribute('fill') === fill,
      'Background choice renders on canvas');
    const xml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
    const exported = [...xml.querySelectorAll('g')].find(g => g.textContent?.includes('Browser-verified'))!.querySelector('rect')!;
    check(exported.getAttribute('fill') === fill, 'Background choice exports unchanged');
  }
  for (const [style, dash] of [['Dashed', '12 9'], ['Solid', null], ['Dotted', '0 9']] as const) {
    window.document.querySelector('[aria-label="Border style"]')!
      .querySelector<HTMLButtonElement>(`[aria-label="${style}"]`)!.click();
    await waitFor(() => snapshot.document.nodes.some(n => n.id === thickShape.id && n.strokeStyle === style.toLowerCase()));
    const body = window.document.querySelector(`g.dg-node[data-id="${thickShape.id}"] .dg-node__body`)!;
    check(body.getAttribute('stroke') === '#ff8389', 'Properties border colour renders with dark-canvas contrast');
    check(body.getAttribute('stroke-dasharray') === dash, 'Properties border style renders on the canvas');
    if (style === 'Dotted') check(getComputedStyle(body).strokeLinecap === 'round', 'Dotted borders use round dots');
    const xml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
    const exported = [...xml.querySelectorAll('g')].find(g => g.textContent?.includes('Browser-verified'))!.querySelector('rect')!;
    check(exported.getAttribute('stroke') === '#da1e28' && exported.getAttribute('stroke-dasharray') === dash
      && exported.getAttribute('stroke-width') === '3', 'Export matches border colour, style and thickness');
  }
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === thickShape.id && n.strokeStyle === 'solid'));
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === thickShape.id && n.strokeStyle === 'dotted'));
  borderColours.querySelector<HTMLButtonElement>('[aria-label="None"]')!.click();
  await waitFor(() => snapshot.document.nodes.some(n => n.id === thickShape.id && n.stroke === 'none'));
  check(window.document.querySelector(`g.dg-node[data-id="${thickShape.id}"] .dg-node__body`)?.getAttribute('stroke') === 'none',
    'No-border choice removes the visible border');
  borderColours.querySelector<HTMLButtonElement>('[aria-label="#da1e28"]')!.click();
  await waitFor(() => snapshot.document.nodes.some(n => n.id === thickShape.id && n.stroke === '#da1e28'));
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
  check(window.document.querySelector('.dg-edge__label text')?.getAttribute('font-size') === '12',
    'Legacy connector labels retain their 12px default');
  for (const size of [10, 24, 36]) {
    await setThickness('Text size', size);
    await waitFor(() => snapshot.document.edges[0]?.fontSize === size);
    const rendered = window.document.querySelector('.dg-edge__label text')!;
    check(rendered.getAttribute('font-size') === String(size), 'Connector text size renders on canvas');
    const xml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
    const exported = [...xml.querySelectorAll('text')].find(text => text.textContent?.includes('Request'))!;
    check(exported.getAttribute('font-size') === String(size), 'Connector text size is exported');
    check(exported.getAttribute('y') === rendered.getAttribute('y'), 'Canvas and export connector label positions match');
  }
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => snapshot.document.edges[0]?.fontSize === 24);
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => snapshot.document.edges[0]?.fontSize === 36);
  clickButton('Connector style');
  await waitFor(() => window.document.querySelector('select[aria-label="Connector text size"]') !== null);
  await setThickness('Connector text size', 24);
  await waitFor(() => snapshot.document.edges[0]?.fontSize === 24);
  clickButton('Edit label (Enter)');
  await waitFor(() => window.document.querySelector('.dg-label-editor') !== null);
  const zoom = snapshot.document.viewport.zoom;
  check(Math.abs(Number.parseFloat((window.document.querySelector('.dg-label-editor') as HTMLElement).style.fontSize)
    - Math.max(11, 24 * zoom)) < 0.01, 'Inline connector editor uses selected font size');
  window.document.querySelector('.dg-label-editor')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(20);
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
  check(snapshot.document.edges[0]?.fontSize === 24, 'Connector text size survives reopening');
  check(snapshot.document.nodes.some(n => n.label === 'Browser-verified process' && n.strokeWidth === 3),
    'Shape thickness survives reopening and duplication');
  check(snapshot.document.nodes.filter(n => n.label === 'Browser-verified process')
    .every(n => n.stroke === '#da1e28' && n.strokeStyle === 'dotted'), 'Border colour and style survive reopening and duplication');
  check(snapshot.document.nodes.filter(n => n.label === 'Browser-verified process').every(n => n.fill === '#1c2d4a'),
    'Background colour survives reopening and duplication');
  clickButton('Add Document');
  await waitFor(() => snapshot.document.nodes.some(n => n.kind === 'document'));
  const documentNode = snapshot.document.nodes.find(n => n.kind === 'document')!;
  const documentBody = window.document.querySelector(`g.dg-node[data-id="${documentNode.id}"] path.dg-node__body`)!;
  check(documentBody.getAttribute('d')?.includes(' Q') === true, 'Document shape has a wavy bottom edge');
  documentBody.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => window.document.querySelector('.dg-label-editor') !== null);
  const documentLabel = window.document.querySelector<HTMLTextAreaElement>('.dg-label-editor')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(documentLabel, 'Specification artefact');
  documentLabel.dispatchEvent(new Event('input', { bubbles: true }));
  await delay(20);
  documentLabel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => snapshot.document.nodes.some(n => n.id === documentNode.id && n.label === 'Specification artefact'));
  const documentXml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
  const documentGroup = [...documentXml.querySelectorAll('g')].find(g => [...g.querySelectorAll('tspan')].map(t => t.textContent).join(' ') === 'Specification artefact')!;
  check(documentGroup.querySelector('path')?.getAttribute('d') === documentBody.getAttribute('d'),
    'Document canvas and export use identical shape geometry');
  const bottomPort = portPoint(documentNode, 'bottom', documentNode.kind);
  check(bottomPort.y === documentNode.y + documentNode.height - documentWaveDepth(documentNode.height),
    'Document bottom connector attaches to the wavy edge');
  const documentConnector = { ...snapshot.document.edges[0]!, sourceId: documentNode.id, sourcePort: 'bottom' as const };
  const endpoints = edgeEndpoints(documentConnector, new Map(snapshot.document.nodes.map(n => [n.id, n])));
  check(endpoints?.s.y === bottomPort.y, 'Saved document routes use the same bottom port as the canvas');
  const exportedText = documentGroup.querySelector('text')!;
  check(Number(exportedText.querySelector('tspan')?.getAttribute('y')) < bottomPort.y - documentWaveDepth(documentNode.height),
    'Document text stays above the wavy edge');
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === documentNode.id && n.label === 'Document'));
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === documentNode.id && n.label === 'Specification artefact'));
  root.render(null);
  await waitFor(() => window.document.querySelector('.dg-editor') === null);
  queryClient.clear();
  mountEditor();
  await waitFor(() => window.document.querySelector(`g.dg-node[data-id="${documentNode.id}"]`) !== null);
  check(snapshot.document.nodes.some(n => n.id === documentNode.id && n.kind === 'document' && n.label === 'Specification artefact'),
    'Document artefact survives save and reopen');
  clickButton('Add Container');
  await waitFor(() => snapshot.document.nodes.some(n => n.label === 'Group' && n.fontSize === 18));
  const headingNode = snapshot.document.nodes.find(n => n.label === 'Group')!;
  await setThickness('Text size', 24);
  await waitFor(() => snapshot.document.nodes.some(n => n.id === headingNode.id && n.fontSize === 24));
  const heading = window.document.querySelector(`g.dg-node[data-id="${headingNode.id}"] text`)!;
  check(heading.getAttribute('font-size') === '24', 'Properties text size changes container heading');
  const headingXml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
  check([...headingXml.querySelectorAll('text')].find(text => text.textContent === 'Group')?.getAttribute('font-size') === '24',
    'Export preserves enlarged container text');
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === headingNode.id && n.fontSize === 18));
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === headingNode.id && n.fontSize === 24));
  await setProperty('Shape or connector title', 'Imagine\nOperations');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === headingNode.id && n.label === 'Imagine\nOperations'));
  for (const size of [18, 24, 36]) {
    await setThickness('Text size', size);
    await waitFor(() => snapshot.document.nodes.some(n => n.id === headingNode.id && n.fontSize === size));
    for (const alignment of ['Top', 'Middle', 'Bottom']) {
      window.document.querySelector('[aria-label="Text vertical alignment"]')!
        .querySelector<HTMLButtonElement>(`[aria-label="${alignment}"]`)!.click();
      await waitFor(() => snapshot.document.nodes.some(n => n.id === headingNode.id && n.textVerticalAlign === alignment.toLowerCase()));
      const current = snapshot.document.nodes.find(n => n.id === headingNode.id)!;
      const group = window.document.querySelector(`g.dg-node[data-id="${headingNode.id}"]`)!;
      const dividerY = Number(group.querySelector('.dg-node__divider')!.getAttribute('y1'));
      check(dividerY - current.y === Math.ceil(size * 2.25 + 12), 'Divider grows for two title lines at the selected font size');
      const lines = [...group.querySelectorAll('text tspan')];
      check(lines.length === 2, 'Container header retains both title lines');
      check(Number(lines[0]!.getAttribute('y')) - size / 2 >= current.y,
        'Heading remains below the container top');
      check(Number(lines[1]!.getAttribute('y')) + size / 2 <= dividerY - 5,
        'Heading stays above divider with padding at every alignment');
      const xml = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'white'), 'image/svg+xml');
      const exported = [...xml.querySelectorAll('g')].find(g => g.textContent === 'ImagineOperations')!;
      check(Number(exported.querySelector('line')!.getAttribute('y1')) === dividerY, 'Export divider matches the live header');
      check(exported.querySelector('text tspan')!.getAttribute('y') === lines[0]!.getAttribute('y'),
        'Export heading position matches the live header');
    }
  }
  await setThickness('Text size', 24);
  await waitFor(() => snapshot.document.nodes.some(n => n.id === headingNode.id && n.fontSize === 24));
  root.render(null);
  await waitFor(() => window.document.querySelector('.dg-editor') === null);
  queryClient.clear();
  mountEditor();
  await waitFor(() => window.document.querySelector(`g.dg-node[data-id="${headingNode.id}"]`) !== null);
  check(snapshot.document.nodes.some(n => n.id === headingNode.id && n.fontSize === 24), 'Text size survives reopening');
  const reopenedHeader = window.document.querySelector(`g.dg-node[data-id="${headingNode.id}"]`)!;
  check(Number(reopenedHeader.querySelector('.dg-node__divider')!.getAttribute('y1')) - headingNode.y === 66,
    'Dynamic multiline header survives reopening');
  check(snapshot.document.nodes.find(n => n.id === experience.id)?.fontSize === 14, 'Existing saved label sizes stay unchanged');
  check(!(await diagramSvg(snapshot.document, assets, 'white')).includes('Process owner: Operations'), 'Descriptions must not clutter visual exports');
  clickButton('Add Text');
  await waitFor(() => snapshot.document.nodes.some(n => n.kind === 'text' && n.label === 'Text'));
  const calloutId = snapshot.document.nodes.find(n => n.kind === 'text' && n.label === 'Text')!.id;
  await setProperty('Shape or connector title', 'Review the ownership');
  await waitFor(() => snapshot.document.nodes.some(n => n.id === calloutId && n.label === 'Review the ownership'));
  const setCallout = async (type: string): Promise<void> => {
    const select = window.document.querySelector<HTMLSelectElement>('select[aria-label="Callout type"]')!;
    check(select !== null, 'Text shapes expose Callout type in Properties');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, type);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => snapshot.document.nodes.find(n => n.id === calloutId)?.calloutType === (type === '' ? undefined : type));
  };
  const plainHeight = snapshot.document.nodes.find(n => n.id === calloutId)!.height;
  for (const type of DIAGRAM_CALLOUT_TYPES) {
    await setCallout(type);
    const current = snapshot.document.nodes.find(n => n.id === calloutId)!;
    const group = window.document.querySelector(`g.dg-node[data-id="${calloutId}"]`)!;
    const header = calloutLayout(current)!;
    check(group.querySelector('.dg-callout')?.getAttribute('data-callout-type') === type, 'Live callout category matches saved value');
    check(group.querySelector('.dg-callout__type')?.textContent === DIAGRAM_CALLOUTS[type].label, 'Callout shows a readable category label');
    const glyph = group.querySelector('.dg-callout__icon')!;
    check(glyph.getAttribute('d') === header.path && getComputedStyle(glyph).stroke !== 'none', 'Callout has its own visible outline icon');
    check(current.height === plainHeight + 32, 'Switching category does not repeatedly grow the text shape');
    const exported = new DOMParser().parseFromString(await diagramSvg(snapshot.document, assets, 'transparent'), 'image/svg+xml');
    const exportedHeader = exported.querySelector(`[data-callout-type="${type}"]`)!;
    check(exportedHeader.querySelector('path')!.getAttribute('transform') === glyph.getAttribute('transform'), 'SVG and canvas icon positions agree');
    check(Number(group.querySelector('text.dg-node__label tspan')!.getAttribute('y')) - current.fontSize / 2 >= current.y + header.height,
      'Callout body text clears the icon and category label');
  }
  await setCallout('');
  check(window.document.querySelector(`g.dg-node[data-id="${calloutId}"] .dg-callout`) === null, 'Plain text removes the callout header');
  check(snapshot.document.nodes.find(n => n.id === calloutId)!.height === plainHeight, 'Removing classification restores the body height');
  clickButton('Undo (Ctrl+Z)');
  await waitFor(() => snapshot.document.nodes.find(n => n.id === calloutId)?.calloutType === 'action');
  clickButton('Redo (Ctrl+Shift+Z)');
  await waitFor(() => snapshot.document.nodes.find(n => n.id === calloutId)?.calloutType === undefined);
  await setCallout('risk');
  const calloutGroup = window.document.querySelector(`g.dg-node[data-id="${calloutId}"]`)!;
  calloutGroup.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => window.document.querySelector('.dg-label-editor') !== null);
  const labelBox = window.document.querySelector<HTMLElement>('.dg-label-editor')!;
  const current = snapshot.document.nodes.find(n => n.id === calloutId)!;
  check(Math.abs(Number.parseFloat(labelBox.style.top) - (snapshot.document.viewport.y + (current.y + 32) * snapshot.document.viewport.zoom)) < 0.1,
    'Inline callout editing starts below the type header');
  labelBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => window.document.querySelector('.dg-label-editor') === null);
  clickButton('Duplicate (Ctrl+D)');
  await waitFor(() => snapshot.document.nodes.filter(n => n.calloutType === 'risk' && n.label === 'Review the ownership').length === 2);
  root.render(null);
  await waitFor(() => window.document.querySelector('.dg-editor') === null);
  queryClient.clear();
  mountEditor();
  await waitFor(() => window.document.querySelectorAll('.dg-callout[data-callout-type="risk"]').length === 2);
  check(window.document.documentElement.scrollWidth <= innerWidth + 1, 'Callout controls fit desktop and mobile without page overflow');
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
  return ['Diagram Athena opens with canvas context and per-diagram conversation at desktop/mobile widths',
    'Short pending chats have no scroll range; long chats scroll and panel resizing updates overflow',
    'Representative architecture and process flow render', 'SVG export full bounds, embedded icon and bidirectional arrows',
    'PNG rasterisation with embedded SVG icon', 'Escaped labels and explicit missing-asset errors',
    'Shape double-click edits instead of adding', 'All nine text alignments match canvas and export',
    'Line and border thickness persist, undo/redo and scale exported arrowheads',
    'Shape border colour, solid/dashed/dotted styles and no-border save and export consistently',
    'Five simple shape backgrounds match canvas and export and survive reopening',
    'Document artefacts add, edit, undo/redo, export and reopen',
    'Text callouts show six distinct icons and categories, clear their text, save/reopen, duplicate, undo/redo and export',
    'Larger default labels and Properties text size persist and export',
    'Standalone horizontal, vertical and diagonal lines export without attachments or arrows',
    'Container divider grows with font size and multiline titles in canvas and exports',
    'Add, label editing, undo/redo and duplication', 'Image-file clipboard paste and explicit URL-only fallback',
    'Save conflict retains local changes and explicit overwrite resolves it',         'Shape and connector properties save/reopen, undo/redo and duplicate without cluttering exports',
    'Note linking, return links in Connections, opening/unlinking and reopening',
    'Create diagram from a note saves pending edits and blocks navigation on save failure',
    'Bundled Microsoft icon picker loads and embeds an official icon', 'Save and reopen retain labels and icons',
    'Missing diagram displays an explicit load error', 'No horizontal page overflow'];
}
Object.assign(window, { runDiagramChecks, runDiagramPropertiesChecks, runDiagramDrilldownChecks, runDiagramLineJumpChecks, diagramFixture: {
  snapshot: () => structuredClone(snapshot), saves: () => saves, conflict: (value: boolean) => { conflict = value; },
  waitFor, clickButton,
} });
