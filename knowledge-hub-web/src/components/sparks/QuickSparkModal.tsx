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
        tags: [],          // We store tag names — resolved in SparksPanel
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

  const handleGlobalKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onClose();
  };

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => { document.removeEventListener('keydown', handleGlobalKeyDown); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="qs-backdrop" onClick={onClose} />
      <div className="qs-modal" role="dialog" aria-label="New Spark" aria-modal="true">
        <p className="qs-label">NEW SPARK</p>
        <p className="qs-hint">Cmd+Enter to save · Esc to cancel</p>

        <textarea
          ref={textRef}
          className="qs-body"
          placeholder="What's on your mind?"
          value={body}
          onChange={(e) => { setBody(e.target.value); }}
          onKeyDown={handleKeyDown}
          rows={4}
        />

        <div className="qs-tags">
          <TagPicker
            selectedIds={tagIds}
            onChange={setTagIds}
            trigger={
              <button className="qs-tag-trigger">
                {tagIds.length === 0 ? '+ Add tags' : `${tagIds.length} tag${tagIds.length === 1 ? '' : 's'}`}
              </button>
            }
          />
        </div>

        {recentItems.length > 0 && (
          <div className="qs-attach">
            <label className="qs-attach-label" htmlFor="qs-attach-select">Attach to…</label>
            <select
              id="qs-attach-select"
              className="qs-attach-select"
              value={attachId}
              onChange={(e) => {
                const selected = recentItems.find((i) => i.id === e.target.value);
                setAttachId(e.target.value);
                setAttachType(selected?.type ?? '');
              }}
            >
              <option value="">— Unattached —</option>
              {recentItems.map((item) => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </div>
        )}

        {error !== null && <p className="qs-error">{error}</p>}

        <div className="qs-actions">
          <button
            className="qs-save-btn"
            disabled={body.trim() === '' || mutation.isPending}
            onClick={() => { mutation.mutate(); }}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button className="qs-cancel-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
};
