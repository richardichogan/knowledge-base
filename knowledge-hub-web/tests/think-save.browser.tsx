import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { MoveToThink } from '../src/components/athena/MoveToThink';
import { AppDialogHost } from '../src/components/AppDialog';
import { api } from '../src/services/api';
import '../src/styles/global.scss';

let failSave = false;
let failLink = false;
let summaries = 0;
api.draftSpecFromSession = async () => ({ success: true, data: { title: 'Saved draft', markdown: '# Draft\n\nBody' } });
api.createNote = async (input) => {
  if (failSave) return { success: false, error: { code: 'TEST', message: 'Save unavailable' } };
  return { success: true, data: { id: 'saved-note', content: input.content, tags: [], linkedItems: [], status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
};
api.linkSessionToNote = async () => failLink
  ? { success: false, error: { code: 'TEST', message: 'Link unavailable' } }
  : { success: true, data: { linkedTasks: 0 } };
function Fixture(): React.ReactElement {
  const location = useLocation();
  return <><output id="route">{location.pathname}</output><textarea defaultValue="Unsent writing" />
    <MoveToThink sessionId="fixture" projectId="" disabled={false} onExportSummary={() => { summaries++; }} />
    <AppDialogHost /></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}>
  <MemoryRouter initialEntries={['/chat']}><Fixture /></MemoryRouter>
</QueryClientProvider>);
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Fixture timeout');
};
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
Object.assign(window, { runThinkSaveChecks: async () => {
  const originalOpen = window.open;
  window.open = () => { throw new Error('Save must not open a window'); };
  try {
    click('.ai-move__button'); await waitFor(() => document.querySelector('.ai-move__go') !== null); click('.ai-move__go');
    await waitFor(() => document.querySelector('dialog[open]') !== null);
    if (!document.querySelector('dialog')!.textContent!.includes('has been saved to Think')) throw new Error('Missing completion popup');
    if (document.querySelector('#route')!.textContent !== '/chat' || document.querySelector('textarea')!.value !== 'Unsent writing') throw new Error('Chat changed');
    click('.kh-dialog__button'); await waitFor(() => document.querySelector('dialog[open]') === null);
    failSave = true;
    click('.ai-move__button'); await waitFor(() => document.querySelector('.ai-move__go') !== null); click('.ai-move__go');
    await waitFor(() => document.querySelector('.ai-move__error') !== null);
    if (document.querySelector('dialog[open]')) throw new Error('False completion on failure');
    failSave = false; failLink = true;
    click('.ai-move__go');
    await waitFor(() => document.querySelector('dialog[open]') !== null);
    if (!document.querySelector('dialog')!.textContent!.includes('could not be linked')) throw new Error('Partial save not reported');
    click('.kh-dialog__button'); await waitFor(() => document.querySelector('dialog[open]') === null);
    click('.ai-move__button');
    await waitFor(() => document.querySelector('.ai-move__go') !== null);
    document.querySelectorAll<HTMLInputElement>('.ai-move__option input')[1]!.click();
    click('.ai-move__go');
    if (summaries !== 1 || document.querySelector('#route')!.textContent !== '/chat') throw new Error('Summary changed route');
    return ['completion popup', 'chat/draft retained', 'no window or navigation', 'save failure', 'partial-link failure', 'summary stays in chat'];
  } finally { window.open = originalOpen; }
} });
