import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SparkPanel } from '../src/features/sparks/SparkPanel';
import { api, type Spark, type SparkCluster } from '../src/services/api';
import '../src/styles/global.scss';

const now = new Date().toISOString();
const spark: Spark = {
  id: 'loose-spark', body: 'Payments need executable organisational authority, not just a payment API.',
  sourceId: null, sourceType: null, sourceTitle: null, tags: [], clusterId: null, createdAt: now,
  usedAt: null, usedType: null, usedRef: null, usedTitle: null,
};
const member = { ...spark, id: 'grouped-spark', clusterId: 'governance', body: 'Agent governance is a runtime concern.' };
const theme: SparkCluster = {
  id: 'governance', theme: 'Agent Platform Governance', status: 'active', sparkCount: 1, surfaced: true, dismissed: false,
  sparks: [member], outputType: null, outputRef: null, outputTitle: null, outputUrl: null,
  developedAt: null, lastGrownAt: now, createdAt: now, updatedAt: now, newSinceDeveloped: 0,
};
let loose = [spark];
let grouped = [member];
let writes = 0;
let fail = true;
api.listSparkClusters = async () => ({ success: true, data: [{ ...theme, sparks: grouped, sparkCount: grouped.length }] });
api.listSparks = async () => ({ success: true, data: loose });
api.updateSpark = async (id, input) => {
  writes++;
  check(id === spark.id && input.cluster_id === theme.id, 'Drop persists the actual Spark/theme identities');
  await new Promise(resolve => setTimeout(resolve, 80));
  if (fail) throw new Error('Fixture move unavailable');
  loose = [];
  const moved = { ...spark, clusterId: theme.id };
  grouped = [...grouped, moved];
  return { success: true, data: moved };
};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><SparkPanel onDevelop={() => {}} /></MemoryRouter>
  </QueryClientProvider>,
);
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Spark fixture timed out: ${document.body.textContent}`);
}
const handle = (): HTMLButtonElement => document.querySelector('.spark-item__drag')!;
const target = (): HTMLElement => document.querySelector('.spark-theme')!;
function begin(): DataTransfer {
  const dataTransfer = new DataTransfer();
  handle().dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
  return dataTransfer;
}
function drop(dataTransfer: DataTransfer): void {
  target().dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
}
async function runSparkChecks(): Promise<string[]> {
  await waitFor(() => handle() !== null && target() !== null);
  // External text/IDs must not be accepted as a local Spark drag.
  const external = new DataTransfer();
  external.setData('application/x-athena-loose-spark', spark.id);
  drop(external);
  check(writes === 0, 'External drag never moves data');
  check(!document.querySelector('.spark-theme .spark-item__drag'), 'Only loose Sparks expose a drag grip');
  handle().focus();
  handle().click();
  await waitFor(() => document.querySelector('.spark-item__move select') !== null);
  check(document.querySelector<HTMLOptionElement>('.spark-item__move option[value="governance"]')?.textContent === theme.theme,
    'Keyboard/touch grip click exposes the existing accessible theme chooser');
  const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('.spark-item__move button')).find(b => b.textContent === 'Cancel')!;
  cancel.click();

  let data = begin();
  await waitFor(() => document.querySelector('.spark-theme--drop-ready') !== null);
  target().dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
  await waitFor(() => document.querySelector('.spark-theme--drag-over') !== null);
  handle().dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  await waitFor(() => document.querySelector('.spark-theme--drop-ready') === null);
  check(writes === 0, 'Cancelling drag is not a write');

  data = begin();
  await waitFor(() => document.querySelector('.spark-theme--drop-ready') !== null);
  const wrong = new DataTransfer();
  wrong.setData('application/x-athena-loose-spark', 'other-spark');
  drop(wrong);
  check(writes === 0, 'Mismatched Spark identity is rejected');
  drop(data);
  drop(data);
  await waitFor(() => writes === 1 && handle().disabled);
  check(document.querySelectorAll('.spark-panel__loose .spark-item').length === 1, 'No optimistic removal before server confirmation');
  await waitFor(() => document.querySelector('[role="alert"]')?.textContent?.includes('Fixture move unavailable') === true);
  check(document.querySelectorAll('.spark-panel__loose .spark-item').length === 1, 'Failure preserves loose Spark for retry');
  fail = false;
  data = begin();
  await waitFor(() => document.querySelector('.spark-theme--drop-ready') !== null);
  drop(data);
  await waitFor(() => document.querySelector('.spark-panel__move-status')?.textContent === `Spark added to ${theme.theme}.`);
  check(writes === 2, 'One successful retry after failed move');
  check(document.querySelectorAll('.spark-panel__loose .spark-item').length === 0, 'Confirmed Spark leaves loose list');
  check(target().querySelectorAll('.spark-item').length === 2 && target().querySelector('.spark-theme__count')?.textContent === '2 sparks',
    'Target membership and count refresh from server');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'Sparks fit the viewport');
  return ['Loose-only drag grip and keyboard/touch chooser', 'Target highlighting and cancelled/invalid drag rejection',
    'Duplicate-drop lock and no optimistic loss', 'Failed move remains retryable', 'Successful persistence refreshes membership and counts', 'Responsive layout'];
}
Object.assign(window, {
  runSparkChecks,
  prepareSparkDrag: async () => {
    await waitFor(() => handle() !== null && target() !== null);
    const data = begin();
    await waitFor(() => document.querySelector('.spark-theme--drop-ready') !== null);
    target().dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    await waitFor(() => document.querySelector('.spark-theme--drag-over') !== null);
  },
  cancelSparkDrag: () => { handle().dispatchEvent(new DragEvent('dragend', { bubbles: true })); },
});
