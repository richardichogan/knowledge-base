/**
 * components/TagPanel.tsx
 * 380px right-side slide-over panel for tag taxonomy management.
 * Tabs: Taxonomy | Review Queue | Health
 */

import React, { useEffect } from 'react';
import { Button } from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { usePendingTags } from '../hooks/useTaxonomy';
import { TagPanelTaxonomy } from './TagPanelTaxonomy';
import { TagManagerReviewQueue } from './tags/TagManagerReviewQueue';
import { TagManagerHealth } from './tags/TagManagerHealth';

interface TagPanelProps {
  open: boolean;
  onClose: () => void;
}

type PanelTab = 'taxonomy' | 'review' | 'health';

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
          <button
            className={`tag-panel-tab${tab === 'health' ? ' tag-panel-tab--active' : ''}`}
            onClick={() => { setTab('health'); }}
          >
            Health
          </button>
        </div>

        {/* Body */}
        <div className="tag-panel-body">
          {tab === 'taxonomy' && <TagPanelTaxonomy />}
          {tab === 'review'   && <TagManagerReviewQueue />}
          {tab === 'health'   && <TagManagerHealth />}
        </div>
      </div>
    </>
  );
};

