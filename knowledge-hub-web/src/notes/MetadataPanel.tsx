/**
 * notes/MetadataPanel.tsx — right-hand panel for the Think page editor.
 * Groups note metadata into collapsible Details/Organisation/GitHub
 * sections (GitHub pinned near the top since it's the most-used action),
 * with Connections kept as its own distinct block below them.
 */

import React from 'react';
import { CONTENT_TYPE_OPTIONS } from './constants';
import type { ContentType } from './constants';
import type { NoteDocument } from './types';
import { TagPicker } from '../components/TagPicker';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';

interface AppliedTag {
  id: string;
  name: string;
}

interface MetadataPanelProps {
  doc: NoteDocument;
  contentType: ContentType;
  onContentTypeChange: (value: ContentType) => void;
  taxonomyTagIds: string[];
  appliedTags: AppliedTag[];
  onTagIdsChange: (ids: string[]) => void;
  wordCount: number;
  readingTime: number;
  blockCount: number;
  ghStatus: 'synced' | 'not-pushed';
  ghDotColor: string;
  githubPath: string | undefined;
  onPushToGitHub: () => void;
}

/** Formats an ISO timestamp as "DD Mon YYYY, HH:MM" for Created/Modified. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export const MetadataPanel: React.FC<MetadataPanelProps> = ({
  doc,
  contentType,
  onContentTypeChange,
  taxonomyTagIds,
  appliedTags,
  onTagIdsChange,
  wordCount,
  readingTime,
  blockCount,
  ghStatus,
  ghDotColor,
  githubPath,
  onPushToGitHub,
}) => {
  return (
    <div className="notes-meta-panel">
      <CollapsibleSection label="Details">
        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Created</p>
          <p className="notes-meta-section-value">{formatDateTime(doc.createdAt)}</p>
        </div>
        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Modified</p>
          <p className="notes-meta-section-value">{formatDateTime(doc.updatedAt)}</p>
        </div>
        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Stats</p>
          <div className="notes-meta-stat-row">
            <span className="notes-meta-stat-label">Words</span>
            <span className="notes-meta-stat-value">{wordCount}</span>
          </div>
          <div className="notes-meta-stat-row">
            <span className="notes-meta-stat-label">Reading time</span>
            <span className="notes-meta-stat-value">{readingTime} min</span>
          </div>
          <div className="notes-meta-stat-row">
            <span className="notes-meta-stat-label">Blocks</span>
            <span className="notes-meta-stat-value">{blockCount}</span>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection label="Organisation">
        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Content type</p>
          <select
            title="Content type"
            className="notes-meta-type-select"
            value={contentType}
            onChange={(e) => { onContentTypeChange(e.target.value as ContentType); }}
          >
            {CONTENT_TYPE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="notes-meta-section">
          <p className="notes-meta-section-label">Tags</p>
          <div className="notes-meta-tags-chips">
            {appliedTags.map((t) => (
              <span key={t.id} className="notes-meta-tag-chip">{t.name}</span>
            ))}
            <TagPicker
              selectedIds={taxonomyTagIds}
              onChange={onTagIdsChange}
              trigger={<button className="notes-tag-picker-trigger">+ Add tag</button>}
            />
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection label="GitHub">
        <div className="notes-meta-section">
          <div className="notes-meta-gh-status">
            <div className="notes-meta-gh-dot" ref={(el) => { if (el) el.style.background = ghDotColor; }} />
            <div>
              <span className="notes-meta-gh-heading">{ghStatus === 'synced' ? 'Synced' : 'Not pushed'}</span>
              <span className="notes-meta-gh-text">
                {ghStatus === 'synced' ? githubPath : 'Push to content-store to sync'}
              </span>
            </div>
          </div>
          <button className="kh-btn-accent notes-meta-gh-push" onClick={onPushToGitHub}>
            ↑ Push to content-store
          </button>
        </div>
      </CollapsibleSection>

      <div className="notes-meta-section notes-meta-section--connections">
        <ConnectionsPanel refId={doc.id} refType="note" />
      </div>
    </div>
  );
};
