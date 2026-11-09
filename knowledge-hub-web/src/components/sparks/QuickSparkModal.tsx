/**
 * components/sparks/QuickSparkModal.tsx
 * Focused quick-capture modal opened by Cmd+. or the header Flash icon.
 *
 * 480px fixed width, keyboard-first:
 *   Cmd+Enter — save and close
 *   Escape     — close without saving
 */
import React, { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TagPicker } from '../TagPicker';
import { api } from '../../services/api';
import { AppDialog } from '../AppDialog';

interface QuickSparkModalProps {
  open: boolean;
  onClose: () => void;
}

interface RecentItem {
  id: string;
  type: string;
  title: string;
}

/** Number of recent items to show in the attach-to dropdown. */
const RECENT_ITEMS_LIMIT = 10;

export const QuickSparkModal: React.FC<QuickSparkModalProps> = ({ open, onClose }) => {
  const qc = useQueryClient();
  const [body, setBody]           = useState('');
  const [tagIds, setTagIds]       = useState<string[]>([]);
  const [attachId, setAttachId]   = useState<string>('');
  const [attachType, setAttachType] = useState<string>('');
  const [error, setError]         = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea when the modal opens
  useEffect(() => {
    if (open) {
      setBody('');
      setTagIds([]);
      setAttachId('');
      setAttachType('');
      setError(null);
      setTimeout(() => textRef.current?.focus(), 50);
    }
  }, [open]);

  // Fetch recent discover items for the attach-to dropdown
  const { data: recentData } = useQuery({
    queryKey: ['discover-recent-for-spark'],
    queryFn: async (): Promise<RecentItem[]> => {
      const res = await api.getDiscoverFeed('to-review', undefined, 1, RECENT_ITEMS_LIMIT);
      if (res.success !== true) return [];
      return res.data.items.map((i) => ({ id: i.id, type: 'discover_item', title: i.title }));
    },
    enabled: open,
    staleTime: 60_000,
  });
  const recentItems = recentData ?? [];

  const mutation = useMutation({
    mutationFn: () => {
      // Resolve tag names from IDs via the taxonomy data
      return api.createSpark({
        body: body.trim(),
        tags: [],          // Tag names, not ids
        source_id:   attachId   !== '' ? attachId   : null,
        source_type: attachType !== '' ? attachType : null,
      });
    },
    onSuccess: (res) => {
      if (res.success !== true) { setError('Failed to save spark'); return; }
      void qc.invalidateQueries({ queryKey: ['sparks'] });
      onClose();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Network error');
    },
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (body.trim() !== '') mutation.mutate();
    }
  };

  if (!open) return null;

  return (
    <AppDialog title="New spark" onClose={onClose}
      actions={<>
        <span className="kh-dialog__hint">⌘↵ to save</span>
        <button type="button" className="kh-dialog__button" onClick={onClose}>Cancel</button>
        <button type="button" className="kh-dialog__button kh-dialog__button--primary" disabled={body.trim() === '' || mutation.isPending}
          onClick={() => { mutation.mutate(); }}>{mutation.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <div className="kh-dialog__field kh-dialog__field--first">
        <label htmlFor="qs-body">What&apos;s on your mind?</label>
        <textarea id="qs-body" ref={textRef} placeholder="What's on your mind?" value={body}
          onChange={(e) => { setBody(e.target.value); }} onKeyDown={handleKeyDown} rows={4} />
      </div>
      <div className="kh-dialog__field">
        <span className="kh-dialog__field-label">Tags</span>
        <TagPicker selectedIds={tagIds} onChange={setTagIds}
          trigger={<button type="button" className="kh-dialog__button kh-dialog__file">
            {tagIds.length === 0 ? '+ Add tags' : `${tagIds.length} tag${tagIds.length === 1 ? '' : 's'}`}
          </button>} />
      </div>
      {recentItems.length > 0 && (
        <div className="kh-dialog__field">
          <label htmlFor="qs-attach-select">Attach to…</label>
          <select id="qs-attach-select" value={attachId}
            onChange={(e) => {
              const selected = recentItems.find((i) => i.id === e.target.value);
              setAttachId(e.target.value);
              setAttachType(selected?.type ?? '');
            }}>
            <option value="">— Unattached —</option>
            {recentItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </div>
      )}
      {error !== null && <p className="kh-dialog__error" role="alert">{error}</p>}
    </AppDialog>
  );
};
