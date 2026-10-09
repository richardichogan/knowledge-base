import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiagramMetadata } from '../src/features/diagram/DiagramMetadata';
import { conversationProjectId } from '../src/chat/composerIntent';
import type { CanvasFullApi } from '../src/services/api';

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
client.setQueryData(['projects', 'diagram-properties'], [
  { id: 'imagine', name: 'IMAGINE' },
  { id: 'cloudt-with-a-chance-of-insights', name: 'Cloudy with a Chance of Insights' },
]);
const canvas: CanvasFullApi = {
  id: 'test', canvasType: 'diagram', title: 'Imagine Agentic Build & Run Model',
  description: 'Agent definitions and deployment', project: 'cloudt-with-a-chance-of-insights',
  createdAt: '', updatedAt: '', linkedNotes: [], nodeCount: 0,
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
};
function render(value: CanvasFullApi): string {
  return renderToStaticMarkup(<QueryClientProvider client={client}>
    <DiagramMetadata canvas={value} onSaved={() => undefined} />
  </QueryClientProvider>);
}
const html = render(canvas);
assert.ok(html.includes('aria-label="Diagram title property"'));
assert.ok(html.includes('aria-label="Diagram description"'));
assert.ok(html.includes('aria-label="Diagram project"'));
assert.ok(html.includes('value="cloudt-with-a-chance-of-insights" selected=""'));
assert.ok(html.includes('Cloudy with a Chance of Insights'));
assert.ok(html.includes('Save diagram properties'));
assert.ok(render({ ...canvas, project: null }).includes('value="" selected=""'));
assert.ok(render({ ...canvas, project: 'legacy-project' }).includes('value="legacy-project" selected=""'));
assert.equal(conversationProjectId(true, undefined, 'cloudt-with-a-chance-of-insights'), null);
assert.equal(conversationProjectId(true, 'imagine', 'cloudt-with-a-chance-of-insights'), 'imagine');
assert.equal(conversationProjectId(false, undefined, 'cloudt-with-a-chance-of-insights'), 'cloudt-with-a-chance-of-insights');
assert.equal(conversationProjectId(false, undefined, ''), null);
client.clear();
console.log('Diagram metadata fields, visible existing/cleared projects and linked-chat grounding verified.');
