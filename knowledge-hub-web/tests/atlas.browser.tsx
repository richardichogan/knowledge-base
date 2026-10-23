import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { GraphPage } from '../src/pages/GraphPage';
import { NoteMiniGraph } from '../src/components/graph/NoteMiniGraph';
import { api, type GraphNode, type GraphEdge, type GraphResponse } from '../src/services/api';
import '../src/styles/global.scss';
import './atlas.fixture.scss';

const now = Date.now();
const node = (id: string, title: string, projectIds: string[] = [], days = 0): GraphNode => ({
  id, refId: id.split(':')[1]!, refType: id.split(':')[0]!, title, projectIds, tags: [], conceptParent: null,
  createdAt: new Date(now - days * 86400000).toISOString(),
});
const nodes = [node('project:a', 'Research programme'), node('project:b', 'IMAGINE', [], 23), node('project:c', 'Partner launch', [], 18),
  node('company:microsoft', 'Microsoft'), node('person:a', 'Alex Example', ['a']),
  node('person:b', 'Sam Example', ['b']), node('note:root', 'Microsoft strategy', ['a']),
  node('note:bridge', 'Shared architecture', ['b'], 23), node('meeting:one', 'Design review', ['a']),
  node('spark:idea', 'Reusable demo', ['a']), node('document:one', 'Launch plan', ['c'], 18),
  node('note:island', 'Unassigned thought', [], 14), node('note:alone', 'Unlinked record', [], 40)];
const edge = (source: string, target: string, edgeType = 'references'): GraphEdge => ({
  id: `${source}/${target}`, source, target, edgeType, confidence: 1, metadata: { evidence: 'Synthetic fixture relationship' }, origin: 'explicit',
});
const edges = [edge('note:root', 'project:a', 'belongs_to'), edge('note:bridge', 'project:b', 'belongs_to'),
  edge('person:a', 'project:a', 'works_on'), edge('person:b', 'project:b', 'works_on'),
  edge('person:a', 'note:bridge'), edge('note:root', 'company:microsoft', 'mentions'),
  edge('document:one', 'project:c', 'belongs_to'), edge('note:island', 'company:microsoft', 'mentions'),
  edge('meeting:one', 'project:a', 'belongs_to'), edge('spark:idea', 'project:a', 'belongs_to')];
if (new URLSearchParams(location.search).has('dense')) {
  nodes.find(n => n.id === 'note:root')!.title = 'STP/RTR weekly delivery alignment, architecture decisions and programme follow-up';
  for (let i = 0; i < 80; i++) {
    const id = `note:dense-${i}`;
    nodes.push(node(id, `Delivery ${i}: long weekly alignment and programme follow-up notes`, ['a']));
    edges.push(edge('note:root', id));
  }
}
const graph: GraphResponse = { nodes, edges, stats: { totalNodes: nodes.length, totalEdges: edges.length, filteredNodes: nodes.length, filteredEdges: edges.length, truncated: false } };
api.getGraph = async params => ({ success: true, data: { ...graph, rootId: params?.seed ?? null } });
api.suggestLinkTargets = async () => ({ success: true, data: [
  { type: 'company', id: 'microsoft', title: 'Microsoft', href: '/companies?companyId=microsoft' },
  { type: 'project', id: 'b', title: 'IMAGINE', href: '/projects?projectId=b' },
] });
const compact = new URLSearchParams(location.search).has('compact');
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter>
  {compact ? <div className="atlas-fixture-compact"><NoteMiniGraph noteId="root" /></div> : <GraphPage />}
</MemoryRouter></QueryClientProvider>);

interface TestElement extends HTMLElement {
  nodes: Array<{ id: string; x: number; y: number; fx: number | null; fy: number | null }>;
  alphaTarget: number; dragging: boolean; path: string[]; cam: { x: number; y: number; k: number };
  cv: HTMLCanvasElement; S(n: TestElement['nodes'][number]): [number, number]; tick(): void; cmd(command: string): void;
  isVis(n: TestElement['nodes'][number]): boolean;
}
const wait = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const findButton = (text: string): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find(b => b.textContent === text);
function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function runAtlasChecks(): Promise<string[]> {
  await customElements.whenDefined('atlas-graph'); await wait(100);
  const graphElement = document.querySelector<TestElement>('atlas-graph')!;
  assert(graphElement?.nodes.length, 'Real custom element has data');
  if (compact) {
    assert(graphElement.getAttribute('scope') === 'note:root', 'Compact root scope');
    assert(graphElement.getAttribute('depth') === '2', 'Compact depth');
    assert(Math.abs(graphElement.getBoundingClientRect().height - 300) < 1, 'Compact height');
    assert(graphElement.nodes.find(n => n.id === 'note:root')?.x === 0, 'Compact root fixed at centre');
    return ['Compact two-hop real graph is 300px high with its note centred'];
  }
  const focus = [...document.querySelectorAll('select')].find(s => s.parentElement?.textContent?.startsWith('Focus type'))!;
  focus.value = 'company'; focus.dispatchEvent(new Event('change', { bubbles: true })); await wait(80);
  graphElement.dispatchEvent(new CustomEvent('atlas-select', { detail: { id: 'company:microsoft' }, bubbles: true }));
  await wait(100);
  assert(graphElement.isVis(graphElement.nodes.find(n => n.id === 'note:root')!), 'Company focus retains linked note');
  assert(document.querySelector('.atlas__connections')?.textContent?.includes('Microsoft strategy'), 'Inspector shows company relationship');
  findButton('Show everything')!.click(); await wait(80);
  const target = graphElement.nodes.find(n => n.id === 'person:a')!;
  const neighbour = graphElement.nodes.find(n => n.id === 'note:bridge')!;
  const [x, y] = graphElement.S(target), rect = graphElement.cv.getBoundingClientRect();
  const capture = graphElement.cv.setPointerCapture;
  graphElement.cv.setPointerCapture = () => {};
  try {
    const dispatch = (type: string, dx: number, dy: number): void => {
      graphElement.cv.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x + dx, clientY: rect.top + y + dy, pointerId: 1, bubbles: true }));
    };
    dispatch('pointerdown', 0, 0); dispatch('pointermove', 110, 30);
    assert(graphElement.alphaTarget === 0.3 && graphElement.dragging, 'Dragging heats live physics');
    const before = [neighbour.x, neighbour.y];
    for (let i = 0; i < 12; i++) graphElement.tick();
    assert(neighbour.x !== before[0] || neighbour.y !== before[1], 'Drag moves connected neighbour');
    dispatch('pointerup', 110, 30); assert(target.fx === null, 'Release resumes physics');
    graphElement.cmd('reflow'); assert(graphElement.nodes.every(n => n.fx === null), 'Reflow has no stale pins');
  } finally { graphElement.cv.setPointerCapture = capture; }
  setInput(document.querySelector<HTMLInputElement>('#atlas-question')!, 'How does Microsoft connect to IMAGINE?');
  await wait(50); findButton('Ask')!.click(); await wait(100);
  assert(document.body.textContent?.includes('Tracing connections...'), 'Real form starts tracing status');
  await wait(1500);
  assert(graphElement.path[0] === 'company:microsoft' && graphElement.path.at(-1) === 'project:b', 'Actual BFS result drives rendered path');
  assert(document.querySelectorAll('.atlas-ask__step').length === graphElement.path.length, 'Accessible step list matches path');
  assert(getComputedStyle(document.querySelector('.atlas-ask__heading')!).display === 'flex', 'Athena heading uses its scoped layout');
  assert(getComputedStyle(document.querySelector('.atlas-ask__step')!, '::before').content !== 'none', 'Path steps have visible connecting markers');
  assert(getComputedStyle(document.querySelectorAll('.atlas-ask__step')[1]!).animationDelay === '0.55s', 'Second path step reveals at 550ms');
  assert(document.body.textContent?.includes("hasn't been touched in 23 days"), 'Quiet-path warning shown');
  assert(document.documentElement.scrollWidth <= window.innerWidth + 1, 'No desktop overflow');
  return ['Company context and inspector retain real relationships', 'Force drag moves neighbours; release and Reflow do not freeze nodes',
    'Ask resolves endpoints, traces actual BFS path and renders synchronised accessible steps and quiet warnings'];
}
Object.assign(window, { runAtlasChecks });
