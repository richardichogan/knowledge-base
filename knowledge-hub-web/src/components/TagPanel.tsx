/**
 * components/TagPanel.tsx
 * 380px right-side slide-over panel for tag taxonomy management.
 * Tabs: Taxonomy | Review Queue
 */

import React, { useEffect } from 'react';
import { Button, InlineLoading, InlineNotification } from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { usePendingTags, useCreateTag, useTaxonomy } from '../hooks/useTaxonomy';
import { api } from '../services/api';
import { TagPanelTaxonomy } from './TagPanelTaxonomy';

interface TagPanelProps {
  open: boolean;
  onClose: () => void;
}

type PanelTab = 'taxonomy' | 'review';

export const TagPanel: React.FC<TagPanelProps> = ({ open, onClose }) => {
  const [tab, setTab] = React.useState<PanelTab>('taxonomy');
  const { data: pending = [] } = usePendingTags();

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (    <>
      {/* Backdrop — click to close */}
      <div className="tag-panel-backdrop" onClick={onClose} />

      <div className="tag-panel tag-panel--open" role="dialog" aria-label="Tag Manager" aria-modal="true">
        {/* Header */}
        <div className="tag-panel-header">
          <h2 className="tag-panel-title">Tag Manager</h2>
          <Button kind="ghost" size="sm" renderIcon={Close} iconDescription="Close" hasIconOnly onClick={onClose} />
        </div>

        {/* Tabs */}
        <div className="tag-panel-tabs">
          <button
            className={`tag-panel-tab${tab === 'taxonomy' ? ' tag-panel-tab--active' : ''}`}
            onClick={() => { setTab('taxonomy'); }}
          >
            Taxonomy
          </button>
          <button
            className={`tag-panel-tab${tab === 'review' ? ' tag-panel-tab--active' : ''}`}
            onClick={() => { setTab('review'); }}
          >
            Review Queue
            {pending.length > 0 && <span className="tag-panel-badge">{pending.length}</span>}
          </button>
        </div>

        {/* Body */}
        <div className="tag-panel-body">
          {tab === 'taxonomy' && <TagPanelTaxonomy />}
          {tab === 'review'   && <ReviewQueueTab />}
        </div>
      </div>
    </>
  );
};

// ── Review Queue Tab ──────────────────────────────────────────────────────────

const ReviewQueueTab: React.FC = () => {
  const { data: pending = [], refetch, isPending: loading } = usePendingTags();
  const { data: parents = [] } = useTaxonomy();
  const createTag = useCreateTag();

  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [newName,    setNewName]    = React.useState('');
  const [parentId,   setParentId]   = React.useState<string>('');
  const [error,      setError]      = React.useState<string | null>(null);

  // Deduplicate — backend returns one row per (suggestion, article), we only need one per suggestion
  const unique = React.useMemo(() => {
    const seen = new Set<string>();
    return pending.filter((p) => { if (seen.has(p.suggestion)) return false; seen.add(p.suggestion); return true; });
  }, [pending]);

  async function dismiss(suggestion: string) {
    setError(null);
    try {
      await api.dismissPendingTag(suggestion);
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to dismiss');
    }
  }

  async function confirmSuggestion(suggestion: string) {
    setError(null);
    try {
      await createTag.mutateAsync({ name: newName || suggestion, parentId: parentId || null });
      // Dismiss from queue server-side so it never reappears
      await api.dismissPendingTag(suggestion);
      setConfirming(null);
      setNewName('');
      setParentId('');
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save tag');
    }
  }

  if (loading) return <InlineLoading description="Loading queue…" />;

  if (unique.length === 0) {
    return <p className="tag-panel-empty-state">No pending suggestions.</p>;
  }

  return (
    <div className="tag-panel-review">
      {error && (
        <InlineNotification
          kind="error"
          title={error}
          lowContrast
          hideCloseButton={false}
          onCloseButtonClick={() => { setError(null); }}
        />
      )}
      {unique.map((item) => (
        <div key={item.suggestion} className="tag-panel-review-row">
          <div className="tag-panel-review-meta">
            <span className="tag-panel-review-suggestion">{item.suggestion}</span>
            <span className="tag-panel-review-source">{item.item_title}</span>
          </div>

          {confirming === item.suggestion ? (
            <div className="tag-panel-review-confirm">
              <select
                value={parentId}
                onChange={(e) => { setParentId(e.target.value); }}
                className="tag-panel-review-select"
                aria-label="Parent tag"
              >
                <option value="">No parent (top-level)</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <input
                value={newName || item.suggestion}
                onChange={(e) => { setNewName(e.target.value); }}
                className="tag-panel-review-input"
                placeholder="Tag name"
                aria-label="Tag name"
              />
              <Button kind="primary" size="sm" onClick={() => { void confirmSuggestion(item.suggestion); }} disabled={createTag.isPending}>
                Save
              </Button>
              <Button kind="ghost" size="sm" onClick={() => { setConfirming(null); }}>Cancel</Button>
            </div>
          ) : (
            <div className="tag-panel-review-actions">
              <Button kind="primary" size="sm" onClick={() => { setConfirming(item.suggestion); setNewName(item.suggestion); }}>
                Confirm
              </Button>
              <Button kind="danger--ghost" size="sm" onClick={() => { void dismiss(item.suggestion); }}>
                Reject
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
