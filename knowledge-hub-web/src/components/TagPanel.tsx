/**
 * components/TagPanel.tsx
 * Settings dialog for tag taxonomy management.
 * Tabs: Taxonomy | Review Queue | Health
 */

import React from 'react';
import { AppDialog } from './AppDialog';
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
  if (!open) return null;

  return <AppDialog title="Tag Manager" onClose={onClose} settings actions={
    <button type="button" className="kh-dialog__button" onClick={onClose}>Done</button>
  }>
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
        <div className="kh-settings-section">
          {tab === 'taxonomy' && <TagPanelTaxonomy />}
          {tab === 'review'   && <TagManagerReviewQueue />}
          {tab === 'health'   && <TagManagerHealth />}
        </div>
  </AppDialog>;
};
