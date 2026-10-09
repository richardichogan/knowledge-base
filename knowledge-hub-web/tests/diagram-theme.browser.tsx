import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiagramEditor } from '../src/features/diagram/DiagramEditor';
import { api } from '../src/services/api';
import { emptyDiagram, type DiagramKind } from '../src/features/diagram/diagramTypes';
import '../src/styles/global.scss';

const document = emptyDiagram();
const kinds: DiagramKind[] = ['process', 'decision', 'terminator', 'container', 'swimlane', 'text', 'image'];
document.nodes = kinds.map((kind, i) => ({
  id: kind, kind, label: kind, x: i % 3 * 180, y: Math.floor(i / 3) * 120,
  width: 140, height: 80, parentId: null, assetId: null, fontSize: 14,
  fill: kind === 'text' || kind === 'image' ? 'none' : kind === 'decision' ? '#fcf4d6' : '#ffffff',
  stroke: '#525252', textColor: '#161616',
}));
document.edges = [{ id: 'edge', sourceId: 'process', targetId: 'decision', sourcePort: 'right', targetPort: 'left',
  route: 'straight', waypoints: [], label: 'Connector', stroke: '#525252', dashed: false, arrows: 'end' }];
api.getDiagram = async () => ({ success: true, data: { revision: 0, document } });
api.getCanvas = async () => ({ success: true, data: {
  id: 'theme', title: 'Dark diagram', description: null, canvasType: 'diagram', project: null,
  createdAt: '', updatedAt: '', linkedNotes: [], nodeCount: document.nodes.length,
  viewport: document.viewport, nodes: [], edges: [],
} });
api.saveDiagram = async (_id, revision, next) => ({ success: true, data: { revision: revision + 1, document: next } });
createRoot(window.document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}><div style={{ height: '100vh' }}><DiagramEditor canvasId="theme" /></div></QueryClientProvider>,
);
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
Object.assign(window, { runDiagramThemeChecks: async () => {
  for (const kind of kinds) {
    const node = window.document.querySelector(`[data-id="${kind}"]`)!;
    const body = node.querySelector('.dg-node__body')!;
    check(getComputedStyle(body).fill !== 'rgb(255, 255, 255)', `${kind} must not render white`);
    check(getComputedStyle(node.querySelector('.dg-node__label')!).fill === 'rgb(244, 244, 244)', `${kind} label is readable`);
  }
  check(getComputedStyle(window.document.querySelector('.dg-edge__line')!).stroke === 'rgb(198, 198, 198)', 'Connector ink is readable');
  check(document.nodes[0]!.fill === '#ffffff', 'Viewing does not mutate stored legacy colours');
  const processButton = window.document.querySelector<HTMLButtonElement>('[aria-label="Add Process"]');
  if (!processButton) throw new Error('Missing process palette button');
  processButton.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  const bodies = [...window.document.querySelectorAll('.dg-node--process .dg-node__body')];
  check(bodies.length === 2 && bodies.every(body => getComputedStyle(body).fill === 'rgb(38, 38, 38)'), 'New process shapes are dark');
  return ['legacy filled shapes dark', 'text/image labels readable', 'connector contrast', 'saved colours preserved', 'new process default dark'];
} });
