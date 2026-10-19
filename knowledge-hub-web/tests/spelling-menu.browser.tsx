import React, { useState } from 'react';
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

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <GlobalContextMenuProvider>
        <Field />
        <NoteEditor doc={{
          id: 'spelling-note', title: 'Spelling', contentType: 'note',
          contentJson: JSON.stringify([
            { type: 'paragraph', content: 'Alpha bravo charlie delta recieve echo.' },
            { type: 'paragraph', content: 'We will definately review the plan.' },
          ]), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }} onSaved={() => {}} />
      </GlobalContextMenuProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
