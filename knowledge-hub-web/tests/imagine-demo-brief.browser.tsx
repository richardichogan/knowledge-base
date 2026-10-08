import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AIChatPage } from '../src/pages/AIChatPage';
import { ChatOutputsTab } from '../src/components/athena/ChatOutputsTab';
import { NoteEditor } from '../src/notes/NoteEditor';
import { AppDialogHost } from '../src/components/AppDialog';
import { AthenaContextProvider } from '../src/context/AthenaContext';
import { imagineDemoBriefPrompt } from '../src/notes/imagineDemoBrief';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import { api } from '../src/services/api';
import '../src/styles/global.scss';

const now = new Date().toISOString();
localStorage.clear();
sessionStorage.clear();
const brief = '# IMAGINE demo brief: Claims Recovery\n\n## 1. Business problem and demonstrable outcome\n\nFull brief export sentinel.\n\n> Use the `evidence-led-demo` skill.';
let copied = '';
let clipboardFail = false;
let exportContent = '';
let exportName = '';
let failRead = false;
let prepareCalls = 0;
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.getNoteGitHub = async () => ({ success: true, data: null });
api.getSessionIdForNote = async () => ({ success: true, data: { sessionId: null } });
api.summarizeNote = async () => ({ success: true, data: { summary: 'Test Use case' } });
api.listModelChoices = async () => ({ success: true, data: [] });
api.listChatOutputs = async () => ({ success: true, data: [{
  id: 'brief-output', sessionId: 'brief-chat', title: 'Claims Recovery', kind: 'spec', format: 'markdown', version: 1, updatedAt: now,
}] });
api.getChatOutput = async () => ({ success: true, data: {
  id: 'brief-output', sessionId: 'brief-chat', title: 'Claims Recovery', kind: 'spec', format: 'markdown', version: 1, updatedAt: now,
  versions: [{ version: 1, content: brief, author: 'athena', note: null, createdAt: now }],
} });
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text: string) => { if (clipboardFail) throw new Error('Permission denied'); copied = text; },
} });
const realCreateUrl = URL.createObjectURL;
URL.createObjectURL = (blob: Blob): string => { void blob.text().then(text => { exportContent = text; }); return realCreateUrl(blob); };
const realClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function (): void {
  if (this.download !== '') { exportName = this.download; return; }
  realClick.call(this);
};

function Fixture(): React.ReactElement {
  const [useCase, setUseCase] = useState(true);
  async function prepare(): Promise<string> {
    prepareCalls++;
    if (failRead) throw new Error('Read failed; source unchanged');
    const editor = getActiveBlockNoteEditor();
    if (!editor) throw new Error('Editor unavailable');
    return imagineDemoBriefPrompt('Live use case', await editor.blocksToMarkdownLossy(editor.document));
  }
  return <>
    <button id="switch-type" onClick={() => { setUseCase(value => !value); }}>Switch content type</button>
    <NoteEditor doc={{
      id: 'brief-source', title: 'Live use case', contentType: useCase ? 'use-case' : 'note',
      contentJson: JSON.stringify([{ type: 'heading', props: { level: 1 }, content: 'Live use case' },
        { type: 'paragraph', content: 'Confirmed business problem.' }]),
      createdAt: now, updatedAt: now,
    }} onSaved={() => {}} />
    <div id="compact-skill" style={{ maxWidth: 430 }}>
      <AIChatPage compact compactVariant="narrow" pageContext={{ type: 'note', id: 'fixture-chat', title: 'Live use case' }}
        prepareDemoBrief={useCase ? prepare : undefined} />
    </div>
    <ChatOutputsTab sessionId="brief-chat" refreshKey={0} />
    <AppDialogHost />
  </>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><AthenaContextProvider><Fixture /></AthenaContextProvider></MemoryRouter>
  </QueryClientProvider>,
);
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('IMAGINE fixture timed out');
}
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function runImagineBriefChecks(): Promise<string[]> {
  await waitFor(() => getActiveBlockNoteEditor() !== null
    && document.querySelector<HTMLButtonElement>('#compact-skill .ai-demo-brief-skill__button')?.disabled === false
    && document.querySelector('[title="Download Markdown brief for GHCP"]') !== null);
  const editor = getActiveBlockNoteEditor()!;
  editor.insertBlocks([{ type: 'paragraph', content: 'Unsaved final business decision. '.repeat(300) }], editor.document.at(-1)!, 'after');
  const original = JSON.stringify(editor.document);
  if (window.innerWidth >= 1200) {
    const actual = document.querySelector<HTMLButtonElement>('#think-side-panel-athena .ai-demo-brief-skill__button');
    check(actual !== null, 'Use case note wires the skill to its actual Athena rail');
    await waitFor(() => !actual!.disabled);
    actual!.click();
    await waitFor(() => document.querySelector<HTMLTextAreaElement>('#think-side-panel-athena textarea')?.value.includes('Unsaved final business decision.') === true);
    check(JSON.stringify(editor.document) === original, 'Actual rail action preserves live writing');
  }
  const button = document.querySelector<HTMLButtonElement>('#compact-skill .ai-demo-brief-skill__button')!;
  button.click();
  const textarea = document.querySelector<HTMLTextAreaElement>('#compact-skill .ai-composer textarea')!;
  try {
    await waitFor(() => textarea.value.includes('Unsaved final business decision.')
      && document.querySelector<HTMLSelectElement>('#compact-skill select[aria-label="Athena persona"]')?.value === 'demo_designer');
  } catch {
    throw new Error(JSON.stringify({ prepareCalls, prompt: textarea.value.slice(0, 100), persona: document.querySelector<HTMLSelectElement>('#compact-skill select[aria-label="Athena persona"]')?.value,
      alert: document.querySelector('#compact-skill [role="alert"]')?.textContent, dialog: document.querySelector('dialog[open]')?.textContent }));
  }
  check(textarea.value.split('Unsaved final business decision.').length === 301, 'Complete long live source, no excerpt');
  check(JSON.stringify(editor.document) === original, 'Source note unchanged');
  check(document.querySelector<HTMLSelectElement>('#compact-skill select[aria-label="Athena persona"]')?.value === 'demo_designer', 'Demo Designer selected');
  check(document.querySelectorAll('#compact-skill .ai-bubble').length === 0, 'Prompt not automatically sent');
  const skill = document.querySelector<HTMLElement>('#compact-skill .ai-demo-brief-skill')!;
  check(skill.scrollWidth <= skill.clientWidth + 1, 'Shortcut fits the compact/mobile pane');
  const prepared = textarea.value;
  button.click();
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent === 'Cancel')!;
  cancel.click();
  await waitFor(() => document.querySelector('dialog[open]') === null);
  check(textarea.value === prepared && prepareCalls === 1, 'Cancel preserves unsent prompt');
  failRead = true;
  button.click();
  await waitFor(() => document.querySelector('dialog[open]') !== null);
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent === 'Replace prompt')!.click();
  await waitFor(() => document.querySelector('#compact-skill [role="alert"]')?.textContent?.includes('Read failed') === true);
  check(textarea.value === prepared && JSON.stringify(editor.document) === original, 'Read failure preserves prompt and note');
  const copy = document.querySelector<HTMLButtonElement>('.ai-output__btn[title="Copy"]')!;
  copy.click();
  await waitFor(() => copied === brief);
  clipboardFail = true;
  copy.click();
  await waitFor(() => document.querySelector('.ai-output__export-error') !== null);
  document.querySelector<HTMLButtonElement>('[title="Download Markdown brief for GHCP"]')!.click();
  await waitFor(() => exportContent === brief && exportName === 'claims-recovery.md');
  check(document.querySelector('.ai-output__brief-path')?.textContent?.includes('docs/prds/') === true, 'Repository placement guidance');
  document.querySelector<HTMLButtonElement>('#switch-type')!.click();
  await waitFor(() => document.querySelector('#compact-skill .ai-demo-brief-skill') === null);
  return ['full unsaved note', 'no automatic send or source replacement', 'Demo Designer selected', 'unsent prompt confirmation/cancel',
    'read errors preserve work', 'copy exact Markdown', 'clipboard error', 'download exact Markdown with safe name', 'Use case-only shortcut'];
}
Object.assign(window, { runImagineBriefChecks });
