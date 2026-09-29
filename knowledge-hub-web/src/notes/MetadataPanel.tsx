/**
 * notes/MetadataPanel.tsx — right-hand side panel for the Think page editor.
 * Tabbed (Athena / Metadata / Connections), drag-resizable and collapsible
 * (⌘J). The Athena tab only appears on wide layouts.
 */

import React, { useEffect, useState } from 'react';
import { SidePanelClose, SidePanelOpen } from '@carbon/icons-react';
import { CONTENT_TYPE_OPTIONS } from './constants';
import type { ContentType } from './constants';
import type { NoteDocument } from './types';
import { TagPicker } from '../components/TagPicker';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';
import type { Project } from '../services/api';
import { useAthenaContext } from '../context/AthenaContext';
import { THINK_ATHENA_RAIL_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { ThinkAthenaPanel } from './ThinkAthenaPanel';
import { PaneResizer } from '../components/PaneResizer';
import { usePersistedBoolean, usePersistedChoice, usePersistedPaneWidth } from '../hooks/usePersistedState';
import type { PaneWidthOptions } from '../hooks/usePersistedState';

const SIDE_PANEL_TABS = ['athena', 'metadata', 'connections'] as const;
type SidePanelTab = typeof SIDE_PANEL_TABS[number];

// Module constant (not an inline literal) so the width hook gets a stable object.
const SIDE_PANEL_WIDTH: PaneWidthOptions = {
  compact: 380,
  wide: 480,
  min: 280,
  // Leave the document at least half the window however hard it is dragged.
  max: (viewport) => Math.round(viewport * 0.5),
};

interface AppliedTag {
  id: string;
  name: string;
}

interface MetadataPanelProps {
  doc: NoteDocument;
  contentType: ContentType;
  onContentTypeChange: (value: ContentType) => void;
  projectId: string;
  projects: Project[];
  onProjectChange: (projectId: string) => void;
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
  projectId,
  projects,
  onProjectChange,
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
  const { pageContext } = useAthenaContext();
  const showAthena = useMediaQuery(THINK_ATHENA_RAIL_QUERY);
  const [athenaBusy, setAthenaBusy] = useState(false);
  const [storedTab, setTab] = usePersistedChoice<SidePanelTab>('kh_think_side_tab', SIDE_PANEL_TABS, 'athena');
  // Narrower Think layouts use the floating Athena launcher instead of a tab.
  const tab: SidePanelTab = !showAthena && storedTab === 'athena' ? 'metadata' : storedTab;
  const [collapsed, setCollapsed] = usePersistedBoolean('kh_think_side_collapsed', false);
  const [width, setWidth] = usePersistedPaneWidth('think-side-panel', SIDE_PANEL_WIDTH);

  // ⌘J / Ctrl+J toggles the side panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [setCollapsed]);

  const tabs: { id: SidePanelTab; label: string }[] = [
    ...(showAthena ? [{ id: 'athena' as const, label: 'Athena' }] : []),
    { id: 'metadata', label: 'Metadata' },
    { id: 'connections', label: 'Connections' },
  ];

  return (
    <>
      {collapsed ? (
        <div className="think-side-strip">
          <button
            type="button"
            className="think-side-strip__btn"
            title="Open side panel (⌘J)"
            aria-label="Open side panel"
            onClick={() => { setCollapsed(false); }}
          >
            <SidePanelOpen size={16} className="think-side-strip__icon" />
          </button>
          {showAthena && (
            <span className={`think-athena-status__dot${athenaBusy ? ' think-athena-status__dot--busy' : ''}`} title={athenaBusy ? 'Athena is thinking…' : 'Athena ready'} />
          )}
        </div>
      ) : (
        <PaneResizer width={width} onResize={setWidth} side="right" label="Resize side panel" />
      )}
      <div
        className="notes-meta-panel"
        hidden={collapsed}
        style={{ width: `${String(width)}px`, minWidth: `${String(width)}px` }}
      >
        <div className="notes-meta-tabs" role="tablist" aria-label="Side panel">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`think-side-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`think-side-panel-${t.id}`}
              className={`notes-meta-tab${tab === t.id ? ' notes-meta-tab--active' : ''}`}
              onClick={() => { setTab(t.id); }}
            >
              {t.id === 'athena' && (
                <span className={`think-athena-status__dot${athenaBusy ? ' think-athena-status__dot--busy' : ''}`} />
              )}
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className="notes-meta-tabs__collapse"
            title="Collapse side panel (⌘J)"
            aria-label="Collapse side panel"
            onClick={() => { setCollapsed(true); }}
          >
            <SidePanelClose size={16} />
          </button>
        </div>

        {/* Athena stays mounted across tab switches so an in-flight reply
            and the thread's scroll position survive. */}
        {showAthena && (
          <div
            role="tabpanel"
            id="think-side-panel-athena"
            aria-labelledby="think-side-tab-athena"
            className="notes-meta-tabpanel notes-meta-tabpanel--athena"
            hidden={tab !== 'athena'}
          >
            <ThinkAthenaPanel pageContext={pageContext ?? undefined} onBusyChange={setAthenaBusy} />
          </div>
        )}

        {tab === 'metadata' && (
          <div role="tabpanel" id="think-side-panel-metadata" aria-labelledby="think-side-tab-metadata" className="notes-meta-tabpanel">
            <CollapsibleSection label="Organisation">
              <div className="notes-meta-section">
                <p className="notes-meta-section-label">Project</p>
                <select
                  title="Project"
                  className="notes-meta-type-select"
                  value={projectId}
                  onChange={(e) => { onProjectChange(e.target.value); }}
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </div>
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

          </div>
        )}

        {tab === 'connections' && (
          <div role="tabpanel" id="think-side-panel-connections" aria-labelledby="think-side-tab-connections" className="notes-meta-tabpanel">
            <ConnectionsPanel refId={doc.id} refType="note" headerless />
          </div>
        )}
      </div>
    </>
  );
};
