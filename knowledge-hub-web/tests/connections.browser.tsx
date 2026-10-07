import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionsPanel } from '../src/components/connections/ConnectionsPanel';
import { api, type ConnectionEdge } from '../src/services/api';
import { GlobalContextMenuProvider } from '../src/context/GlobalContextMenu';
import { SparkList } from '../src/features/sparks/SparkList';
import '../src/styles/global.scss';

let fail = true;
let opened = '';
let sparkWrites = 0;
let failSpark = true;
let failMap = true;
let mapWrites = 0;
const selectedText = 'Private networking needs a control loop that detects changes in intent and verifies that the corrective action actually works.';
const spark = { id: 'spark-id', body: selectedText, sourceId: 'original-note', sourceType: 'note', tags: [], clusterId: null, createdAt: new Date().toISOString() };
const canvas = { id: 'canvas-id', title: 'Architecture ideas', description: null, canvasType: 'brainstorm' as const,
  project: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), linkedNotes: [], nodeCount: 1 };
api.listSparks = async () => ({ success: true, data: [spark] });
api.listCanvases = async () => ({ success: true, data: [canvas, { ...canvas, id: 'diagram-id', title: 'Drawing', canvasType: 'diagram' }] });
api.createSpark = async (input) => {
  sparkWrites++;
  check(input.body === selectedText, 'Spark saves exact selected text, not the note title');
  check(input.source_id === 'original-note' && input.source_type === 'note', 'Spark keeps its original note');
  if (failSpark) return { success: false, error: { code: 'TEST', message: 'Spark unavailable' } };
  return { success: true, data: spark };
};
api.addToCanvas = async (id, input) => {
  mapWrites++;
  check(id === 'canvas-id' && input.refId === spark.id && input.refType === 'spark', 'Canvas node refers to saved Spark');
  check(input.body === selectedText, 'Canvas retains selected text');
  if (failMap) return { success: false, error: { code: 'TEST', message: 'Mapping unavailable' } };
  return { success: true, data: { ...canvas, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] } };
};
window.open = (url) => { opened = String(url); return null; };
const edge = (refType: string, edgeType: string, metadata: ConnectionEdge['metadata']): ConnectionEdge => ({
  edgeId: refType, edgeType, metadata, confidence: 0.9, createdAt: new Date().toISOString(),
  connectedNode: { id: refType, refId: `${refType}-id`, refType, title: `Related ${refType}`, url: 'https://example.com/source' },
});
api.getConnections = async () => {
  if (fail) return { success: false, error: { code: 'TEST', message: 'Unavailable' } };
  return { success: true, data: {
    thematically_related: [
      edge('note', 'thematically_related', { reason: 'This note explains the private networking design needed by the task.' }),
      edge('task', 'thematically_related', { reason: 'The task implements the security controls described here.' }),
      edge('discover_item', 'thematically_related', { reason: 'This article introduces the feature used by the design.' }),
      edge('issue', 'thematically_related', { reason: 'The GitHub issue tracks implementation of this design.' }),
    ],
    tag_overlap: [edge('document', 'tag_overlap', { shared_tags: ['Private networking', 'Security'] })],
  } };
};
function Location(): React.ReactNode { return <output id="location">{useLocation().search}</output>; }
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><GlobalContextMenuProvider><div style={{ padding: 16, maxWidth: 450 }}>
      <ConnectionsPanel refId="source" refType="note" headerless /><Location />
      <div data-ctx-title="Original note title" data-ctx-ref-id="original-note" data-ctx-ref-type="note">
        <p id="selection-text">{selectedText}</p>
      </div><SparkList />
    </div></GlobalContextMenuProvider></MemoryRouter>
  </QueryClientProvider>,
);
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Connections fixture timed out');
}
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function runConnectionsChecks(): Promise<string[]> {
  await waitFor(() => document.querySelector('.conn-panel__error') !== null);
  check(!document.querySelector('.conn-panel__empty'), 'API failure must not look like no connections');
  fail = false;
  document.querySelector<HTMLButtonElement>('.conn-panel__error button')!.click();
  await waitFor(() => document.querySelectorAll('.conn-item').length === 5);
  check(document.querySelector('.conn-panel__intro')!.textContent!.includes('GitHub'), 'Connections explain cross-content scope');
  const reasons = [...document.querySelectorAll<HTMLElement>('.conn-item__reason')];
  check(reasons.length === 5, 'Every contextual connection has a visible reason');
  check(reasons.some(reason => reason.textContent!.includes('Private networking, Security')), 'Shared-tag context is shown');
  for (const reason of reasons) {
    check(getComputedStyle(reason).whiteSpace === 'normal', 'Reasons wrap without hover');
    check(getComputedStyle(reason).position !== 'absolute', 'Reasons stay visible in their row');
  }
  document.querySelector<HTMLButtonElement>('.conn-item__type--note')!.closest('button')!.click();
  await waitFor(() => document.querySelector('#location')!.textContent === '?noteId=note-id');
  document.querySelector<HTMLButtonElement>('.conn-item__type--task')!.closest('button')!.click();
  await waitFor(() => document.querySelector('#location')!.textContent === '?taskId=task-id');
  document.querySelector('.conn-item__type--issue')!.closest('button')!.click();
  check(opened === 'https://example.com/source', 'GitHub connections open the original item');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'No horizontal overflow');
  const selection = window.getSelection()!;
  const target = document.querySelector('#selection-text')!;
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: 100, clientY: 100 }));
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 }));
  await waitFor(() => document.querySelector('.gctx') !== null);
  const clickMenu = (text: string): void => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.gctx button')].find(button => button.textContent!.trim() === text);
    check(!!button, `Missing menu action ${text}`);
    button!.click();
  };
  clickMenu('Create Spark');
  await waitFor(() => document.querySelector('.gctx__error')?.textContent === 'Spark unavailable');
  failSpark = false;
  clickMenu('Create Spark');
  await waitFor(() => [...document.querySelectorAll('.gctx button')].some(button => button.textContent!.includes('Spark saved')));
  check(sparkWrites === 2, 'Failed Spark capture can be retried once');
  clickMenu('Send Spark to Canvas…');
  await waitFor(() => document.querySelector('.gctx__picker-canvas') !== null);
  check(document.querySelectorAll('.gctx__picker-canvas').length === 1, 'Only card-based canvases are offered');
  document.querySelector<HTMLButtonElement>('.gctx__picker-canvas')!.click();
  await waitFor(() => document.querySelector<HTMLButtonElement>('.gctx__picker-send')?.disabled === false);
  clickMenu('Add to Canvas');
  await waitFor(() => document.querySelector('.gctx__error')?.textContent === 'Mapping unavailable');
  failMap = false;
  clickMenu('Add to Canvas');
  await waitFor(() => document.querySelector('.gctx__picker-send')?.textContent?.trim() === 'Added!');
  check(mapWrites === 2, 'Mapping failure can be retried without creating another Spark');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => document.querySelector('.gctx') === null);
  selection.removeAllRanges();
  document.querySelector<HTMLButtonElement>('.spark-row__source--link')!.click();
  await waitFor(() => document.querySelector('#location')!.textContent === '?noteId=original-note');
  document.querySelector<HTMLButtonElement>('.spark-row__map')!.click();
  await waitFor(() => document.querySelector('.gctx') !== null);
  clickMenu('Send to Canvas…');
  await waitFor(() => document.querySelector('.gctx__picker-canvas') !== null);
  document.querySelector<HTMLButtonElement>('.gctx__picker-canvas')!.click();
  await waitFor(() => document.querySelector<HTMLButtonElement>('.gctx__picker-send')?.disabled === false);
  clickMenu('Add to Canvas');
  await waitFor(() => mapWrites === 3);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return ['Mixed content connections', 'Visible contextual reasons', 'Explicit failure and retry', 'Specific note/task links',
    'Original GitHub source', 'Selected text Spark with note provenance', 'Spark-to-Canvas mapping and retries', 'Existing Spark source and mapping actions'];
}
Object.assign(window, { runConnectionsChecks });
