import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PodcastPrepCard, PodcastPrepNotification } from '../src/components/today/PodcastPrepCard';
import { api } from '../src/services/api';
import type { PodcastPrepStatus } from '../src/types/podcastPrep';
import type { ApiResponse } from '../src/types/apiResponse';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let data: PodcastPrepStatus = {
  nextRecording: '2026-10-16', scheduleWarning: null, latestBrief: null,
  run: { recordingDate: '2026-10-16', status: 'ready', sessionId: '11111111-1111-4111-8111-111111111111',
    outputId: '22222222-2222-4222-8222-222222222222', generatedAt: '2026-10-15T06:01:00.000Z',
    acknowledgedAt: null, warnings: ['EP43 transcript unavailable.'], error: null, attempts: 1 },
};
let failAcknowledgement = true;
let generations = 0;
api.getPodcastPrep = async () => success(structuredClone(data));
api.acknowledgePodcastPrep = async (date, generatedAt) => {
  check(date === data.run?.recordingDate && generatedAt === data.run.generatedAt, 'Acknowledgement targets the exact brief version');
  if (failAcknowledgement) throw new Error('Fixture acknowledgement failed');
  data.run!.acknowledgedAt = new Date().toISOString();
  return success(null);
};
api.generatePodcastPrep = async () => {
  generations++;
  data.run!.status = 'running';
  return success(structuredClone(data));
};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}><div style={{ padding: 12 }}>
    <PodcastPrepNotification /><PodcastPrepCard />
  </div></QueryClientProvider>,
);
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Podcast fixture did not reach the expected state');
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
  check(found, `Missing button: ${label}`);
  return found;
}
async function refresh(): Promise<void> {
  await qc.invalidateQueries({ queryKey: ['podcast-prep'] });
  await new Promise(resolve => setTimeout(resolve, 50));
}
declare global { interface Window { runPodcastPrepChecks: () => Promise<string[]> } }
window.runPodcastPrepChecks = async () => {
  const link = document.querySelector<HTMLAnchorElement>('.podcast-prep-notification a')!;
  check(link.getAttribute('href') === '/chat?session=11111111-1111-4111-8111-111111111111&output=22222222-2222-4222-8222-222222222222', 'Opens the exact saved chat/output');
  check(link.target === '_blank', 'Does not steal the current conversation');
  check(document.body.textContent?.includes('research limitations'), 'Flags limited research');
  check(document.documentElement.scrollWidth <= innerWidth + 1, 'Fits the desktop/mobile width');
  button('Dismiss').click();
  await waitFor(() => document.body.textContent?.includes('Could not dismiss') === true);
  check(document.querySelector('.podcast-prep-notification'), 'Failed dismissal leaves the notification visible');
  failAcknowledgement = false;
  button('Dismiss').click();
  await waitFor(() => document.querySelector('.podcast-prep-notification') === null);
  check(document.querySelector('.podcast-prep a'), 'Brief remains accessible from Today after dismissal');
  button('Refresh brief').click();
  await waitFor(() => document.body.textContent?.includes('Researching fresh topics') === true);
  check(button('Preparing...').disabled && generations === 1, 'Running preparation cannot be triggered twice');
  data.run!.status = 'ready'; data.run!.acknowledgedAt = null;
  data.run!.generatedAt = '2026-10-15T06:05:00.000Z';
  await refresh();
  check(document.querySelector('.podcast-prep-notification'), 'Refreshed brief produces a new notification');
  data.run!.status = 'failed'; data.run!.error = 'Research unavailable';
  await refresh();
  check(document.body.textContent?.includes('Research unavailable'), 'Research failure is explicit');
  check(!button('Refresh brief').disabled, 'Failure has an explicit retry/refresh action');
  data.scheduleWarning = 'The saved recording date is not a Friday.';
  await refresh();
  check(button('Refresh brief').disabled, 'Misconfigured recording schedule blocks generation');
  return ['exact chat/output navigation', 'persistent acknowledgement state', 'acknowledgement failure', 'refresh and duplicate protection', 'visible failure', 'schedule warning', 'mobile width'];
};
