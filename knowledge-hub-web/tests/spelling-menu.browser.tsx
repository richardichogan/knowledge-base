import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NoteEditor } from '../src/notes/NoteEditor';
import { GlobalContextMenuProvider } from '../src/context/GlobalContextMenu';
import { api } from '../src/services/api';
import './note-draft-identity';
import '../src/styles/global.scss';

// Driven by a real right-click (browser or Electron); see the spelling-menu probe.
api.getTaxonomy = async () => ({ success: true, data: [] });
api.getNoteTags = async () => ({ success: true, data: [] });
api.getProjects = async () => ({ success: true, data: [] });
api.getNoteGitHub = async () => ({ success: true, data: null });
if (new URLSearchParams(location.search).has('desktop')) {
  (window as unknown as { athenaDesktop: object }).athenaDesktop = {};
}

function Field() {
  const [value, setValue] = useState('Please recieve the plain field text');
  return <>
    <textarea id="plain-textarea" rows={2} cols={60} spellCheck value={value} onChange={(e) => { setValue(e.target.value); }} />
    <output id="plain-value">{value}</output>
  </>;
}

function CodeStabilityProbe(): React.ReactElement {
  const [result, setResult] = useState('Waiting for code-rich writing');
  useEffect(() => {
    let cancelled = false;
    let observer: MutationObserver | undefined;
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      const editor = document.querySelector<HTMLElement>('.bn-editor');
      if (!editor) throw new Error('The writing editor did not mount.');
      const codes = [...editor.querySelectorAll('code')];
      if (codes.length < 17 || codes.some(code => code.getAttribute('spellcheck') !== 'false')) {
        throw new Error('Inline placeholders and code blocks must exclude spelling from their initial render.');
      }
      let mutations = 0;
      observer = new MutationObserver(records => { mutations += records.length; });
      observer.observe(editor, { childList: true, subtree: true, attributes: true });
      await new Promise(resolve => setTimeout(resolve, 500));
      observer.disconnect();
      if (cancelled) return;
      if (mutations !== 0 || codes.some(code => !editor.contains(code))) {
        throw new Error(`Idle code-rich writing is being rewritten (${mutations} DOM mutations).`);
      }
      setResult('PASS: code-rich writing settled without DOM rewrites; prose remains editable');
    })().catch((error: unknown) => {
      if (!cancelled) setResult(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { cancelled = true; observer?.disconnect(); };
  }, []);
  return <output id="code-stability" role="status">{result}</output>;
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <GlobalContextMenuProvider>
        <Field />
        <CodeStabilityProbe />
        <NoteEditor doc={{
          id: 'spelling-note', title: 'Spelling', contentType: 'note',
          contentJson: JSON.stringify([
            { type: 'paragraph', content: 'Alpha bravo charlie delta recieve echo.' },
            { type: 'paragraph', content: 'We will definately review the plan.' },
            ...Array.from({ length: 16 }, (_, index) => ({
              type: 'bulletListItem',
              content: [{ type: 'text', text: `[Training element ${index + 1} placeholder]`, styles: { code: true } }],
            })),
            { type: 'codeBlock', props: { language: 'text' }, content: 'const identifier = "recieve";' },
          ]), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }} onSaved={() => {}} />
      </GlobalContextMenuProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
