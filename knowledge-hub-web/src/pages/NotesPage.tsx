/**
 * NotesPage — Carbon Design System (Change 002).
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button, TextArea, Tile, Tag, InlineLoading,
  InlineNotification, IconButton,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { api } from '../services/api';

export const NotesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data, isPending, isError } = useQuery({
    queryKey: ['notes'],
    queryFn: () => api.getNotes(),
    retry: 1,
  });

  const createMutation = useMutation({
    mutationFn: (text: string) => api.createNote({ content: text }),
    onSuccess: (result) => {
      if (result.success) {
        setContent('');
        setFeedback({ ok: true, msg: 'Note saved.' });
        void queryClient.invalidateQueries({ queryKey: ['notes'] });
      } else {
        setFeedback({ ok: false, msg: result.error.message });
      }
    },
    onError: (err: unknown) => {
      setFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Network error' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });

  const notes = data?.success === true ? data.data.items : [];

  return (
    <div className="page-root">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Notes</h1>
        </div>
        <div className="page-controls">
          <Button
            renderIcon={Add}
            onClick={() => { if (content.trim()) createMutation.mutate(content.trim()); }}
            disabled={createMutation.isPending || content.trim() === ''}
          >
            {createMutation.isPending ? 'Saving…' : 'Save Note'}
          </Button>
        </div>
      </div>

      <Tile style={{ marginBottom: '1.5rem' }}>
        <TextArea
          id="note-input"
          labelText="New note"
          placeholder="Capture a thought, observation, or idea…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
        />
        {feedback !== null && (
          <InlineNotification
            kind={feedback.ok ? 'success' : 'error'}
            title={feedback.msg}
            lowContrast
            style={{ marginTop: '0.75rem' }}
            onClose={() => setFeedback(null)}
          />
        )}
      </Tile>

      {isPending && !isError && <InlineLoading description="Loading notes…" />}
      {isError && <p className="note-error">Failed to load notes. Is the backend running?</p>}

      {notes.map((note) => (
        <Tile key={note.id} className="note-item">
          <div className="note-item__row">
            <p className="note-item__text">{note.content}</p>
            <IconButton
              kind="ghost"
              size="sm"
              label="Delete note"
              onClick={() => deleteMutation.mutate(note.id)}
            >
              <TrashCan />
            </IconButton>
          </div>
          <div className="note-item__footer">
            <span className="note-item__date">
              {new Date(note.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            {note.tags.map((tag) => <Tag key={tag} type="gray" size="sm">{tag}</Tag>)}
          </div>
        </Tile>
      ))}
      {!isPending && notes.length === 0 && (
        <p className="note-empty">No notes yet. Write one above.</p>
      )}
    </div>
  );
};
