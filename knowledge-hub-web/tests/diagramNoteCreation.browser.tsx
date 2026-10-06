import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { NoteEditor } from '../src/notes/NoteEditor';
import { getActiveBlockNoteEditor } from '../src/utils/activeBlockNoteEditor';
import { api } from '../src/services/api';
import type { NoteDocument } from '../src/notes/types';
import { THINK_ATHENA_RAIL_QUERY } from '../src/hooks/useMediaQuery';

export async function checkDiagramFromNote(client: QueryClient, waitFor: (predicate: () => boolean) => Promise<void>): Promise<void> {
  api.getProjects = async () => ({ success: true, data: [] });
  api.getTaxonomy = async () => ({ success: true, data: [] });
  api.getNoteTags = async () => ({ success: true, data: [] });
  let rejectSave = true;
  let savedContent = '';
  let source: string | null = null;
  api.patchNote = async (id, content) => {
    if (rejectSave) return { success: false, error: { code: 'TEST_FAILURE', message: 'Fixture save failed' } };
    savedContent = content;
    return { success: true, data: { id, content, createdAt: '', updatedAt: '', tags: [], linkedItems: [], status: 'active' } };
  };
  const doc: NoteDocument = {
    id: crypto.randomUUID(), title: 'Process requirements', contentType: 'note',
    contentJson: JSON.stringify([{ type: 'paragraph', content: 'Initial process details' }]),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  localStorage.setItem('kh_think_side_collapsed', 'true');
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => {
    const media = matchMedia.call(window, query);
    if (query === THINK_ATHENA_RAIL_QUERY) Object.defineProperty(media, 'matches', { value: false });
    return media;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let phase = 'mounting note editor';
  try {
    root.render(<QueryClientProvider client={client}><NoteEditor doc={doc} onSaved={() => undefined} onCreateDiagram={async (id) => { source = id; }} /></QueryClientProvider>);
    await waitFor(() => getActiveBlockNoteEditor() !== null && host.querySelector('.bn-editor') !== null);
    const editor = getActiveBlockNoteEditor()!;
    editor.updateBlock(editor.document[0]!, { content: 'Updated process details for the linked diagram' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Create diagram'));
    if (create === undefined) throw new Error('Note toolbar must expose Create diagram');
    phase = 'blocking creation after a failed save';
    create.click();
    await waitFor(() => host.textContent?.includes('Save failed') === true);
    if (source !== null) throw new Error('Failed note save must not navigate away or create a diagram');
    rejectSave = false;
    phase = 'creating from the saved note';
    create.click();
    await waitFor(() => source !== null);
    if (source !== doc.id || !savedContent.includes('Updated process details for the linked diagram')) throw new Error('Create diagram must save note edits before passing the source note ID');
  } catch (err) {
    throw new Error(`${phase}: ${err instanceof Error ? err.message : String(err)}; ${host.textContent}`);
  } finally {
    root.unmount();
    host.remove();
    localStorage.removeItem('kh_think_side_collapsed');
    window.matchMedia = matchMedia;
  }
}
