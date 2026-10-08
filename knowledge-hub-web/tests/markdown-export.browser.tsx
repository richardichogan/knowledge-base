import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { textToBlocks } from '../../knowledge-hub-backend/src/ai/markdownToNoteBlocks';
import { IMAGINE_DEMO_BRIEF_TEMPLATE } from '../../knowledge-hub-backend/src/ai/imagineDemoBriefSkill';
import { NoteEditor } from '../src/notes/NoteEditor';
import { api } from '../src/services/api';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import '../src/styles/global.scss';

const sample = '# IMAGINE: Client Report Assurance\n## High fidelity prototype specification\nVersion: 0.1\n\n## Purpose\nBody **bold** and [policy](https://example.test/policy).\n\nAssumptions:\n- First\n  - Nested\n- Second\n\n3. Third\n4. Fourth\n\n- [x] Done\n- [ ] Waiting\n\n> Human approval remains required.\n\n```text\n## literal code\n```\n\n';
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.getNoteGitHub = async () => ({ success: true, data: null });
let copied = '';
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><NoteEditor doc={{
      id: 'markdown-handoff', title: 'Client Report Assurance', contentType: 'use-case',
      contentJson: JSON.stringify(textToBlocks(sample + IMAGINE_DEMO_BRIEF_TEMPLATE)),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }} onSaved={() => {}} /></MemoryRouter>
  </QueryClientProvider>,
);
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function runMarkdownExportChecks(): Promise<string[]> {
  const editor = getActiveBlockNoteEditor()!;
  check(editor !== null, 'Actual editor mounted server-created blocks');
  const all = editor.document;
  check(all.filter(block => block.type === 'heading').length === 14, 'All consecutive and brief headings are native headings');
  check(document.querySelectorAll('.bn-editor h1, .bn-editor h2, .bn-editor h3').length >= 14, 'Headings render as headings');
  check(all.filter(block => block.type === 'table').length === 2, 'Both brief tables mount');
  check(document.querySelectorAll('.bn-editor table').length === 2, 'Tables render natively');
  check(all.some(block => block.type === 'bulletListItem' && block.children.length > 0), 'Nested list retained');
  check(all.some(block => block.type === 'checkListItem' && block.props.checked === true), 'Checkbox state retained');
  check(all.some(block => block.type === 'quote'), 'Quote retained');
  check(document.querySelector('.bn-editor a[href="https://example.test/policy"]') !== null, 'Policy link retained');
  document.querySelector<HTMLButtonElement>('.notes-copy-btn')!.click();
  for (let i = 0; i < 150 && copied === ''; i++) await new Promise(resolve => setTimeout(resolve, 20));
  check(copied.includes('# IMAGINE: Client Report Assurance'), 'Markdown copy has real heading');
  check(copied.includes('Own/assigned/shared scope') && copied.includes('Retry, duplicate action or restart'), 'Both tables survive roundtrip');
  check(copied.includes('## literal code'), 'Code stays literal');
  check(copied.includes('evidence-led-demo') && copied.includes('do not stop at a harness or plan'), 'Full build instruction survives');
  return ['actual editor accepts server Markdown blocks', 'consecutive headings', 'nested lists', 'checkboxes', 'tables', 'quotes', 'links', 'code preservation', 'full Markdown copy roundtrip'];
}
Object.assign(window, { runMarkdownExportChecks });
