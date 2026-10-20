/**
 * notes/MetadataPanel.tsx — right-hand side panel for the Think page editor.
 * Tabbed (Athena / Metadata / Connections), drag-resizable and collapsible
 * (⌘J). Narrow layouts open the panel as a drawer without squeezing the editor.
 */

import React, { useEffect, useState } from 'react';
import { SidePanelClose } from '@carbon/icons-react';
import { CONTENT_TYPE_GROUPS, CONTENT_TYPE_OPTIONS } from './constants';
import type { ContentType } from './constants';
import type { NoteDocument } from './types';
import { TagPicker } from '../components/TagPicker';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';
import { NoteMaps } from '../features/canvas/NoteMaps';
import { RelatedSparks } from '../features/sparks/RelatedSparks';
import type { Project } from '../services/api';
import { api } from '../services/api';
import { useQueryClient } from '@tanstack/react-query';
import { useAthenaContext } from '../context/AthenaContext';
import { ThinkAthenaPanel } from './ThinkAthenaPanel';
import { NoteHistoryPanel } from './NoteHistoryPanel';
import { usePersistedChoice, usePersistedPaneWidth } from '../hooks/usePersistedState';
import { LinkPreviewContent } from './LinkPreviewPanel';
import { onLinkPreview } from './linkPreview';
import type { EntityLinkTarget } from './entityLinks';
import { WorkspaceSidePanel, useResponsivePanelState } from '../components/WorkspaceSidePanel';
import { EntityChip } from '../identity';
import { UseCaseLauncher } from '../features/useCases/UseCaseLauncher';
import { launchFromRef } from '../features/useCases/useCaseView';
import type { PaneWidthOptions } from '../hooks/usePersistedState';
import { NoteBacklinks } from './NoteBacklinks';
import { ProjectOptions } from '../components/ProjectOptions';
import { UnlinkedMentions } from './UnlinkedMentions';

const SIDE_PANEL_TABS = ['athena', 'metadata', 'connections', 'history', 'link'] as const;
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
  /** Ids of tags Athena applied automatically (shown with an 'auto' marker and one-click remove). */
  autoTagIds: string[];
  noteId: string;
  onTagIdsChange: (ids: string[]) => void;
  wordCount: number;
  readingTime: number;
  blockCount: number;
  ghStatus: 'synced' | 'not-pushed' | 'pending' | 'conflict' | 'error';
  ghDotColor: string;
  githubPath: string | undefined;
  githubUrl?: string | undefined;
  githubError: string;
  githubBusy: boolean;
  onCheckGitHub: () => void;
  onPushToGitHub: () => void;
  /** Open one of this note's mind maps. */
  onOpenMap?: (mapId: string) => void;
  /** Create (or open) this note's mind map. */
  onMapNote?: (noteId: string) => void;
  onRestoreVersion: (versionId: string) => Promise<void>;
  historyRefresh: number;
  prepareDemoBrief: () => Promise<string>;
  onShowEditor?: (() => void) | undefined;
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
  autoTagIds,
  noteId,
  onTagIdsChange,
  wordCount,
  readingTime,
  blockCount,
  ghStatus,
  ghDotColor,
  githubPath,
  githubUrl,
  githubError,
  githubBusy,
  onCheckGitHub,
  onPushToGitHub,
  onOpenMap,
  onMapNote,
  onRestoreVersion,
  historyRefresh,
  prepareDemoBrief,
  onShowEditor,
}) => {
  const { pageContext, registerAthenaLauncher, request: athenaRequest } = useAthenaContext();
  const qc = useQueryClient();
  const [retagging, setRetagging] = useState(false);
  const [athenaBusy, setAthenaBusy] = useState(false);
  const [storedTab, setTab] = usePersistedChoice<SidePanelTab>('kh_think_side_tab', SIDE_PANEL_TABS, 'athena');
  const [useCaseOpen, setUseCaseOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<EntityLinkTarget | null>(null);
  const [linkHistory, setLinkHistory] = useState<EntityLinkTarget[]>([]);
  const previewOrigin = React.useRef<HTMLElement | null>(null);
  const previousTab = React.useRef<SidePanelTab>('athena');
  const tab: SidePanelTab = storedTab === 'link' && !linkTarget ? 'athena' : storedTab;
  const useCaseLaunch = launchFromRef('note', doc.id, doc.title);
  const [width, setWidth] = usePersistedPaneWidth('think-side-panel', SIDE_PANEL_WIDTH);
  const panelRef = React.useRef<HTMLDialogElement>(null);
  const { collapsed, setCollapsed, overlay } = useResponsivePanelState('kh_think_side_collapsed', panelRef, width);
  useEffect(() => {
    return registerAthenaLauncher(() => {
      onShowEditor?.();
      setTab('athena');
      setCollapsed(false);
      window.requestAnimationFrame(() => { panelRef.current?.querySelector<HTMLTextAreaElement>('.think-athena-panel textarea')?.focus(); });
    });
  }, [registerAthenaLauncher, setTab, setCollapsed, onShowEditor]);

  useEffect(() => onLinkPreview(target => {
    if (!linkTarget) {
      previewOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      previousTab.current = tab === 'link' ? 'athena' : tab;
    }
    if (linkTarget && (target.type !== linkTarget.type || target.id !== linkTarget.id)) {
      setLinkHistory(previous => [...previous, linkTarget]);
    }
    setLinkTarget(target);
    setTab('link');
    setCollapsed(false);
  }), [setTab, setCollapsed, linkTarget, tab]);

  const closePreview = React.useCallback((): void => {
    setLinkTarget(null);
    setLinkHistory([]);
    setTab(previousTab.current);
    if (overlay) setCollapsed(true);
    window.requestAnimationFrame(() => { previewOrigin.current?.focus({ preventScroll: true }); });
  }, [setTab, setCollapsed, overlay]);

  useEffect(() => {
    if (tab !== 'link' || collapsed) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [tab, collapsed, closePreview]);

  // A prompt sent from elsewhere (e.g. "Discuss with Athena" on selected text) opens the Athena tab.
  const lastRequest = React.useRef(athenaRequest?.sequence ?? 0);
  useEffect(() => {
    if (athenaRequest === null || athenaRequest.sequence === lastRequest.current) return;
    lastRequest.current = athenaRequest.sequence;
    onShowEditor?.();
    setTab('athena');
    setCollapsed(false);
  }, [athenaRequest, setTab, setCollapsed, onShowEditor]);

  // ⌘J / Ctrl+J toggles the side panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (collapsed) onShowEditor?.();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [setCollapsed, collapsed, onShowEditor]);

  const tabs: { id: SidePanelTab; label: string }[] = [
    { id: 'athena', label: 'Athena' },
    { id: 'metadata', label: 'Metadata' },
    { id: 'connections', label: 'Connections' },
    { id: 'history', label: 'History' },
    ...(linkTarget ? [{ id: 'link' as const, label: 'Link' }] : []),
  ];

  return (
      <WorkspaceSidePanel panelRef={panelRef} label="Think side panel" width={width} onResize={setWidth}
        collapsed={collapsed} setCollapsed={setCollapsed} overlay={overlay} status={athenaBusy ? 'busy' : 'idle'}>
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
                <span className={`think-athena-status__dot${athenaBusy ? ' think-athena-status__dot--busy' : ''}`}
                  role="img" aria-label={athenaBusy ? 'Athena is generating a reply' : 'Athena is idle'}
                  title={athenaBusy ? 'Generating a reply' : 'Idle — this is activity, not save or sync status'} />
              )}
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className="notes-meta-tabs__collapse"
            title={overlay ? 'Close side panel (Esc)' : 'Collapse side panel (⌘J)'}
            aria-label={overlay ? 'Close side panel' : 'Collapse side panel'}
            onClick={() => { setCollapsed(true); }}
          >
            <SidePanelClose size={16} />
          </button>
        </div>

        {/* Athena stays mounted across tab switches so an in-flight reply
            and the thread's scroll position survive. */}
          <div
            role="tabpanel"
            id="think-side-panel-athena"
            aria-labelledby="think-side-tab-athena"
            className="notes-meta-tabpanel notes-meta-tabpanel--athena"
            hidden={tab !== 'athena'}
          >
            <ThinkAthenaPanel pageContext={pageContext ?? undefined} onBusyChange={setAthenaBusy} promptRequest={athenaRequest ?? undefined}
              prepareDemoBrief={contentType === 'use-case' ? prepareDemoBrief : undefined} />
          </div>

        {tab === 'link' && linkTarget && (
          <div role="tabpanel" id="think-side-panel-link" aria-labelledby="think-side-tab-link" className="notes-meta-tabpanel">
            <LinkPreviewContent target={linkTarget} onClose={closePreview} onBack={linkHistory.length ? () => {
              setLinkTarget(linkHistory[linkHistory.length - 1] ?? null);
              setLinkHistory(previous => previous.slice(0, -1));
            } : undefined} />
          </div>
        )}

        {tab === 'history' && (
          <div role="tabpanel" id="think-side-panel-history" aria-labelledby="think-side-tab-history" className="notes-meta-tabpanel">
            <NoteHistoryPanel noteId={noteId} refresh={historyRefresh} onRestore={onRestoreVersion} />
          </div>
        )}
        {tab === 'metadata' && (
          <div role="tabpanel" id="think-side-panel-metadata" aria-labelledby="think-side-tab-metadata" className="notes-meta-tabpanel">
            <CollapsibleSection label="Organisation">
              <div className="notes-meta-section notes-meta-pair">
                <label className="notes-meta-pair__field">
                  <span className="notes-meta-section-label">Project</span>
                  <select
                    className="notes-meta-type-select"
                    value={projectId}
                    title={projects.find((project) => project.id === projectId)?.name ?? 'No project'}
                    onChange={(e) => { onProjectChange(e.target.value); }}
                  >
                    <option value="">No project</option>
                    <ProjectOptions projects={projects} selected={projectId} />
                  </select>
                </label>
                <label className="notes-meta-pair__field">
                  <span className="notes-meta-section-label">Content type</span>
                  <select
                    className="notes-meta-type-select"
                    value={contentType}
                    title={CONTENT_TYPE_OPTIONS.find((option) => option.id === contentType)?.label ?? 'Content type'}
                    onChange={(e) => { onContentTypeChange(e.target.value as ContentType); }}
                  >
                    {CONTENT_TYPE_GROUPS.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.options.map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </div>
              <div className="notes-meta-section">
                <p className="notes-meta-section-label">Tags</p>
                <div className="notes-meta-tags-chips">
                  {appliedTags.map((t) => {
                    const auto = autoTagIds.includes(t.id);
                    return (
                      <EntityChip key={t.id} tagId={t.id} fallbackLabel={t.name}
                        suffix={auto ? <span className="notes-meta-tag-auto" title="Added automatically by Athena">auto</span> : undefined}
                        removeTitle={auto ? "Remove this tag (Athena won't re-add it)" : 'Remove this tag'}
                        onRemove={() => onTagIdsChange(taxonomyTagIds.filter((id) => id !== t.id))} />
                    );
                  })}
                  <TagPicker
                    selectedIds={taxonomyTagIds}
                    onChange={onTagIdsChange}
                    trigger={<button className="notes-tag-picker-trigger">+ Add tag</button>}
                  />
                  <button type="button" className="notes-tag-picker-trigger" disabled={retagging}
                    title="Let Athena suggest tags for this note again"
                    onClick={() => { setRetagging(true); void api.retagNote(noteId).then(() => qc.invalidateQueries({ queryKey: ['note-tags', noteId] })).finally(() => setRetagging(false)); }}>
                    {retagging ? 'Tagging…' : 'Re-tag'}
                  </button>
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

            <CollapsibleSection label="Use case">
              <div className="notes-meta-section">
                <p className="notes-github-help">Turn this note into a use case (or add it to one) so Athena can draft a spec from it for GitHub Copilot or Athena Build.</p>
                <div className="notes-meta-gh-actions">
                  <button type="button" className="notes-meta-gh-action" onClick={() => { setUseCaseOpen(true); }}>Make a use case…</button>
                </div>
              </div>
            </CollapsibleSection>
            {useCaseOpen && useCaseLaunch !== null && (
              <UseCaseLauncher launch={{ ...useCaseLaunch, projectId: doc.projectId ?? null }} onClose={() => { setUseCaseOpen(false); }} />
            )}

            <CollapsibleSection label="GitHub">
              <div className="notes-meta-section">
                <div className="notes-meta-gh-status">
                  <div className="notes-meta-gh-dot" ref={(el) => { if (el) el.style.background = ghDotColor; }} />
                  <div className="notes-meta-gh-summary">
                    <span className="notes-meta-gh-heading">
                      {{ synced: 'Published to GitHub', 'not-pushed': 'Not published', pending: 'Update pending', conflict: 'GitHub changed', error: 'Publishing failed' }[ghStatus]}
                    </span>
                    <span className="notes-meta-gh-text">
                      {githubUrl ? <a href={githubUrl} target="_blank" rel="noopener noreferrer">{githubPath}</a> : 'Publish a linked copy in content-store'}
                    </span>
                  </div>
                </div>
                <p className="notes-github-help">Think is the master. Saves update the published file after editing settles. This copy is not added separately to Library or Athena's context.</p>
                {githubError && <p className="notes-github-error" role="alert">{githubError}</p>}
                <div className="notes-meta-gh-actions">
                <button type="button" className="notes-meta-gh-action notes-meta-gh-action--primary" disabled={githubBusy} onClick={onPushToGitHub}>
                  {githubBusy ? 'Working...' : ghStatus === 'conflict' ? 'Review versions' : ghStatus === 'not-pushed' ? 'Publish to GitHub' : 'Publish latest'}
                </button>
                {githubUrl && <button type="button" className="notes-meta-gh-action" disabled={githubBusy} onClick={onCheckGitHub}>Check GitHub</button>}
                </div>
              </div>
            </CollapsibleSection>

          </div>
        )}

        {tab === 'connections' && (
          <div role="tabpanel" id="think-side-panel-connections" aria-labelledby="think-side-tab-connections" className="notes-meta-tabpanel">
            <NoteBacklinks noteId={noteId} />
            <UnlinkedMentions noteId={noteId} />
            <ConnectionsPanel refId={doc.id} refType="note" headerless />
            <RelatedSparks refId={doc.id} refType="note" />
            {onOpenMap !== undefined && <NoteMaps noteId={doc.id} onOpenMap={onOpenMap} {...(onMapNote !== undefined && { onMapNote })} />}
          </div>
        )}
      </WorkspaceSidePanel>
  );
};
