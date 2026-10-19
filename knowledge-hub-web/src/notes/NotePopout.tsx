import React, { useEffect, useMemo, useState } from 'react';
import { usePageTitle } from '../navigation/PageTitle';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import type { PartialBlock } from '@blocknote/core';
import '@blocknote/mantine/style.css';
import { DataNotice } from '../components/DataNotice';
import { BlockNoteViewWrapper } from './BlockNoteViewWrapper';
import { BLOCKNOTE_G100_THEME } from './constants';
import { editorSchema } from './editorSchema';
import { fetchNote } from './noteStorage';

const REFRESH_MS = 5000;

export class NoteWritingBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: Error): void { console.error('[Think] Could not display writing.', error); }
  render(): React.ReactNode {
    return this.state.failed
      ? <p className="note-popout__error" role="alert">This note could not be displayed. Reopen it to retry. Your writing in Think is unchanged.</p>
      : this.props.children;
  }
}

export function NoteWriting({ contentJson }: { contentJson: string }): React.ReactElement {
  const blocks = useMemo(() => {
    const parsed: unknown = JSON.parse(contentJson);
    if (!Array.isArray(parsed)) throw new Error('Note writing is not a block array.');
    return parsed as PartialBlock[];
  }, [contentJson]);
  const editor = useCreateBlockNote({
    schema: editorSchema,
    initialContent: blocks.length ? blocks : [{ type: 'paragraph', content: '' }],
  });
  useEffect(() => {
    // Keep the same editor DOM and scroll position as saved writing changes.
    editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph', content: '' }]);
  }, [blocks, editor]);
  return <BlockNoteViewWrapper editor={editor} theme={BLOCKNOTE_G100_THEME} editable={false} />;
}

export const NotePopout: React.FC = () => {
  const { noteId = '' } = useParams<{ noteId: string }>();
  const [missingImage, setMissingImage] = useState(false);
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['note-popout', noteId],
    queryFn: async () => {
      const note = await fetchNote(noteId);
      if (!note) throw new Error('This note is no longer available.');
      return note;
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });
  usePageTitle({ item: data?.title ?? 'Note' });

  return (
    <main className="note-popout" aria-label="Note content (read only)" onErrorCapture={event => {
      if (event.target instanceof HTMLImageElement) setMissingImage(true);
    }}>
      {isPending && <p className="note-popout__status" role="status">Loading note...</p>}
      {missingImage && <p className="note-popout__error" role="status">An image could not be loaded. Reopen this window to retry.</p>}
      {error && <DataNotice title={data ? 'This view could not refresh. Showing the last loaded writing.' : 'Could not load note'}
        error={error} busy={isFetching} onRetry={() => { void refetch(); }} />}
      {data && <NoteWritingBoundary key={noteId}><NoteWriting contentJson={data.contentJson} /></NoteWritingBoundary>}
    </main>
  );
};
