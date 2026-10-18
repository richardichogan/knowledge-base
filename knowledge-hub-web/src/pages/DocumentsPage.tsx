/**
 * DocumentsPage — document library.
 *
 * Surfaces formal markdown artifacts from two sources:
 *   1. richardichogan/content-store  — blog drafts, specs, newsletters, etc.
 *   2. /docs folders in project repos — project documentation
 *
 * Left panel  — progressively rendered document list, filtered before batching.
 * Right panel — read-only markdown viewer with View on GitHub link.
 * ?docId= accepts a library identity or knowledge-graph document ID.
 *
 * No repo dropdown. No file tree. The library is the navigation.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading, Tag } from '@carbon/react';
import { Document, Launch, DocumentAdd, ArrowLeft } from '@carbon/icons-react';
import { api } from '../services/api';
import type { DocEntry, DocType } from '../services/api';
import { TagPicker } from '../components/TagPicker';
import { useTaxonomy, expandTagIds } from '../hooks/useTaxonomy';
import { useProjects } from '../hooks/useProjects';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';
import { useAthenaContext } from '../context/AthenaContext';
import { SideTabsPanel } from '../components/SideTabsPanel';
import { OneDriveStatus } from '../components/library/OneDriveStatus';
import { LocalFoldersPanel } from '../components/library/LocalFoldersPanel';
import { DocumentList } from '../components/library/DocumentList';
import { findDocument, searchDocuments } from '../components/library/documentListModel';
import { desktopErrorMessage, getDesktop } from '../types/desktop';
import { ThinkAthenaPanel } from '../notes/ThinkAthenaPanel';
import { THINK_ATHENA_RAIL_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import type { PaneWidthOptions } from '../hooks/usePersistedState';
import { alertDialog } from '../services/appDialogs';
import { requireApiSuccess, describeApiError } from '../services/apiError';
import { DataNotice } from '../components/DataNotice';
import { PageHeader } from '../components/PageHeader';

// Same cap as Think notes: enough for long specs, bounded for the model.
const DOC_CONTEXT_MAX_CHARS = 100_000;

// Module constant so the width hook gets a stable object.
const LIBRARY_SIDE_WIDTH: PaneWidthOptions = {
  compact: 380,
  wide: 480,
  min: 280,
  max: (viewport) => Math.round(viewport * 0.5),
};
import { EntityChip, IdentityChip, identitiesFor, useIdentity } from '../identity';
import { renderMarkdown } from '../utils/markdown';

// ── Source config ─────────────────────────────────────────────────────────────

// ── Type badge config ─────────────────────────────────────────────────────────

const TYPE_LABEL: Record<DocType, string> = {
  'blog-draft': 'Blog draft',
  spec: 'Spec',
  newsletter: 'Newsletter',
  readme: 'README',
  doc: 'Doc',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Local tag storage ─────────────────────────────────────────────────────────
// ── Page ──────────────────────────────────────────────────────────────────────

export const DocumentsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('docId');
  const selectDocument = useCallback((id: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (id === null) next.delete('docId');
      else next.set('docId', id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [activeProjectId, setActiveProjectId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  // Optimistic overrides: docId → tagIds (updated immediately on change before refetch)
  const [tagOverrides, setTagOverrides] = useState<Map<string, string[]>>(new Map());
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadProjectId, setUploadProjectId] = useState('personal');
  const [uploadLoading, setUploadLoading] = useState(false);
  const [tagSaving, setTagSaving] = useState(false);
  const tagSavingRef = useRef(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { pageContext, setAthenaContext } = useAthenaContext();
  const showAthena = useMediaQuery(THINK_ATHENA_RAIL_QUERY);
  const [athenaBusy, setAthenaBusy] = useState(false);
  const { data: projectRecords = [] } = useProjects();
  const projectOptions = projectRecords;
  const extraRepos = useMemo(() => projectRecords.flatMap((project) => project.githubRepos), [projectRecords]);
  const repoLabels = useMemo(() => Object.fromEntries(
    projectRecords.flatMap((project) => project.githubRepos.map((repo) => [repo, project.name] as const)),
  ), [projectRecords]);

  // ── Fetch unified library ──────────────────────────────────────────────────
  const { data: libraryData, isPending: libraryPending, error: libraryError, refetch: reloadLibrary } = useQuery({
    queryKey: ['documents-library', extraRepos, repoLabels],
    queryFn: async () => requireApiSuccess(await api.getDocumentLibrary(extraRepos, repoLabels)),
    staleTime: 5 * 60_000,
  });

  const allDocs: DocEntry[] = useMemo(() => {
    const docs = libraryData?.success === true ? libraryData.data : [];
    // Apply optimistic tag overrides
    return docs.map((d) => tagOverrides.has(d.id) ? { ...d, taxonomyTagIds: tagOverrides.get(d.id)! } : d);
  }, [libraryData, tagOverrides]);

  // Taxonomy hooks
  const { data: taxonomyTree = [] } = useTaxonomy();
  const identity = useIdentity();

  // Filter by active taxonomy tag IDs + search query
  const visibleDocs = useMemo(() => {
    let docs = activeProjectId === ''
      ? allDocs
      : allDocs.filter((doc) => doc.projectId === activeProjectId);
    docs = activeTagIds.size === 0
      ? docs
      : docs.filter((doc) => {
          const docTagIds = doc.taxonomyTagIds ?? [];
          // For each selected tag, expand to include its children
          return [...activeTagIds].some((selectedId) => {
            const matchIds = expandTagIds(selectedId, taxonomyTree);
            return docTagIds.some((id) => matchIds.has(id));
          });
        });
    return searchDocuments(docs, searchQuery);
  }, [allDocs, activeProjectId, activeTagIds, searchQuery, taxonomyTree]);
  const documentFilterKey = JSON.stringify([activeProjectId, [...activeTagIds].sort(), searchQuery.trim().toLocaleLowerCase()]);

  function toggleTagId(id: string): void {
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectedDoc = findDocument(allDocs, selectedId);
  const selectedDocIsUpload = selectedDoc?.repo === 'kb-uploads';
  const selectedDocIsOneDrive = selectedDoc?.repo === 'onedrive';

  // ── Tag save handler ───────────────────────────────────────────────────────
  const handleDocTagChange = useCallback(async (ids: string[]) => {
    if (!selectedDoc || tagSavingRef.current) return;
    tagSavingRef.current = true;
    setTagSaving(true);
    setTagError(null);
    const previousOverride = tagOverrides.get(selectedDoc.id);
    setTagOverrides((prev) => new Map([...prev, [selectedDoc.id, ids]]));
    try {
      requireApiSuccess(await api.setDocumentTags(selectedDoc.id, ids));
      void qc.invalidateQueries({ queryKey: ['documents-library'] });
    } catch (error) {
      setTagError(`Tags for ${selectedDoc.title} were not saved: ${describeApiError(error)}`);
      setTagOverrides((prev) => {
        const next = new Map(prev);
        if (previousOverride === undefined) next.delete(selectedDoc.id);
        else next.set(selectedDoc.id, previousOverride);
        return next;
      });
    } finally {
      tagSavingRef.current = false;
      setTagSaving(false);
    }
  }, [selectedDoc, qc, tagOverrides]);

  // ── Fetch selected document content ───────────────────────────────────────
  const { data: contentData, isPending: contentPending, error: contentError, refetch: reloadContent } = useQuery({
    queryKey: ['document-content', selectedDoc?.repo, selectedDoc?.path],
    queryFn: async () => requireApiSuccess(await api.getDocumentContent(selectedDoc!.repo, selectedDoc!.path)),
    enabled: selectedDoc !== null,
    staleTime: 10 * 60_000,
  });

  const renderedHtml = useMemo(() => {
    if (contentData?.success !== true) return '';
    return renderMarkdown(contentData.data.content);
  }, [contentData]);

  // Athena sees the open document's actual text (not just its path), and
  // each document keeps its own conversation (id links the chat, as notes do).
  const docText = contentData?.success === true ? contentData.data.content : '';
  useEffect(() => {
    if (selectedDoc === null) {
      setAthenaContext(null);
      return;
    }
    // Wait for the text: Athena's opening summary is generated as soon as the
    // context appears, and with only the path it could only guess.
    if (contentPending || contentData?.success !== true) {
      setAthenaContext(null);
      return;
    }
    const meta = [
      `Project: ${selectedDoc.sourceLabel}`,
      `Repo: ${selectedDoc.repo}`,
      `Path: ${selectedDoc.path}`,
      `Type: ${TYPE_LABEL[selectedDoc.type]}`,
    ].join(' | ');
    setAthenaContext({
      type: 'document',
      title: selectedDoc.title,
      detail: docText !== '' ? `${meta}\n\nContent:\n${docText.slice(0, DOC_CONTEXT_MAX_CHARS)}` : meta,
      id: `doc:${selectedDoc.contentItemId ?? selectedDoc.id}`,
      ...(selectedDoc.projectId !== 'personal' && { projectId: selectedDoc.projectId }),
    });
    return () => { setAthenaContext(null); };
  }, [selectedDoc, docText, contentPending, contentData?.success, setAthenaContext]);

  // ── Upload handler ─────────────────────────────────────────────────────────
  const handleUpload = useCallback(async (file: File) => {
    setUploadLoading(true);
    try {
      const uploadProjectName = projectOptions.find((project) => project.id === uploadProjectId)?.name;
      const data = await api.uploadDocument(file, uploadProjectId, uploadTitle, uploadProjectName);
      if (data.success) {
        void alertDialog(`Uploaded "${data.data.filename}" to ${data.data.projectName}`, { title: 'Document uploaded', tone: 'success' });
        setUploadDialogOpen(false);
        setUploadTitle('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        setActiveProjectId(data.data.projectId);
        // Refetch library
        void qc.invalidateQueries({ queryKey: ['documents-library'] });
      } else {
        throw new Error(data.error?.message ?? 'Upload failed');
      }
    } catch (err) {
      void alertDialog(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, { title: 'Upload failed', tone: 'danger' });
    } finally {
      setUploadLoading(false);
    }
  }, [projectOptions, uploadProjectId, uploadTitle, qc]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.toLowerCase().split('.').pop() || '';
    if (!['pdf', 'docx', 'xlsx', 'pptx'].includes(ext)) {
      void alertDialog(`Unsupported file type: .${ext}\n\nSupported: PDF, DOCX, XLSX, PPTX`, { title: 'Unsupported file type', tone: 'danger' });
      return;
    }

    void handleUpload(file);
  }, [handleUpload]);

  return (
    <div className="docs-page" role="main" data-active-pane={selectedDoc === null ? 'list' : 'editor'}>
      <PageHeader title="Sources" subtitle={allDocs.length > 0 ? <>
        {allDocs.length.toLocaleString()} document{allDocs.length !== 1 ? 's' : ''}
        {(activeProjectId !== '' || activeTagIds.size > 0 || searchQuery.trim() !== '') && ` · ${visibleDocs.length.toLocaleString()} matching`}
      </> : undefined} actions={<>
        {selectedDoc !== null && <button type="button" className="kb-import-btn kh-workspace-back"
          onClick={() => { selectDocument(null); }}><ArrowLeft size={16} />Documents</button>}
        <button
          className="docs-upload-btn"
          onClick={() => setUploadDialogOpen(true)}
          title="Upload PDF, DOCX, XLSX, or PPTX"
        >
          <DocumentAdd size={20} />
          Upload Document
        </button>
      </>} />

      <OneDriveStatus />
      <LocalFoldersPanel />

      {/* ── Three-panel body ── */}
      <div className="docs-body">

        {/* ── Left: document list ── */}
        <div className="docs-list-panel">

          {/* Search */}
          <div className="docs-search">
            <input
              type="search"
              className="docs-search__input"
              aria-label="Search documents by title, source or path"
              placeholder="Search documents…"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); }}
            />
          </div>

          <div className="docs-project-filter">
            <label className="docs-project-filter__label" htmlFor="docs-project-filter">Project</label>
            <select
              id="docs-project-filter"
              className="docs-project-filter__select"
              value={activeProjectId}
              onChange={(e) => { setActiveProjectId(e.target.value); }}
            >
              <option value="">All projects</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>

          {/* Collapsible tag filter */}
          {taxonomyTree.length > 0 && (
            <div className="docs-tag-filter">
              <button
                className="docs-tag-filter__toggle"
                onClick={() => { setTagFilterOpen((v) => !v); }}
              >
                Filter by tag {activeTagIds.size > 0 && `(${activeTagIds.size} active)`}
                <span className={`docs-tag-filter__arrow${tagFilterOpen ? ' docs-tag-filter__arrow--open' : ''}`}>▾</span>
              </button>
              {tagFilterOpen && (
                <div className="docs-tag-filter__chips">
                  {taxonomyTree.map((parent) => (
                    <EntityChip key={parent.id} tagId={parent.id} fallbackLabel={parent.name} size="md"
                      active={activeTagIds.has(parent.id)} onClick={() => { toggleTagId(parent.id); }} />
                  ))}
                  {activeTagIds.size > 0 && (
                    <button className="docs-tag-chip docs-tag-chip--clear" onClick={() => { setActiveTagIds(new Set()); }}>
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {libraryPending && <InlineLoading description="Loading documents…" className="docs-loading" />}
          {libraryError !== null && <DataNotice title="Sources are unavailable" error={libraryError} onRetry={() => { void reloadLibrary(); }} />}
          {tagError !== null && <DataNotice title="Source tags were not saved" error={tagError} />}

          <DocumentList
            key={documentFilterKey}
            matches={visibleDocs}
            selectedDoc={selectedDoc}
            pending={libraryPending}
            failed={libraryError !== null}
            onSelect={selectDocument}
          />
        </div>

        <div className="docs-document-area">
        {/* ── Middle: markdown viewer ── */}
        <div className="docs-viewer">
          {selectedDoc === null && (
            <div className="docs-viewer__empty">
              <Document size={48} />
              <p>Select a document to read it</p>
            </div>
          )}

          {selectedDoc !== null && contentPending && (
            <InlineLoading description={`Loading ${selectedDoc.title}…`} className="docs-loading" />
          )}
          {selectedDoc !== null && contentError !== null && <DataNotice title="Document content is unavailable" error={contentError} onRetry={() => { void reloadContent(); }} />}

          {selectedDoc !== null && !contentPending && contentData?.success === true && (
            <>
              <div className="docs-viewer__toolbar">
                <div className="docs-viewer__file-info">
                  <Tag
                    type="gray"
                    size="sm"
                  >
                    {TYPE_LABEL[selectedDoc.type]}
                  </Tag>
                  <span className="docs-viewer__filename">{selectedDoc.path}</span>
                  <Tag type="gray" size="sm">{formatBytes(selectedDoc.size)}</Tag>
                </div>
                <a
                  href={selectedDoc.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="docs-viewer__gh-link"
                >
                  <Launch size={14} />
                  {selectedDocIsOneDrive ? 'Open in OneDrive' : selectedDocIsUpload ? 'Open original' : 'View on GitHub'}
                </a>
              </div>
              {contentData.data.fromIndex === true && (
                <p className="docs-viewer__notice">
                  GitHub couldn&apos;t be reached for this file, so this is the indexed text copy (formatting removed).
                </p>
              )}
              <div
                className="docs-viewer__content"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            </>
          )}
        </div>

        {/* ── Right: tabbed side panel (Athena / Details / Connections) ── */}
        {selectedDoc !== null && (
          <SideTabsPanel
            storageKey="library-side"
            label="Document side panel"
            defaultTab={showAthena ? 'athena' : 'details'}
            width={LIBRARY_SIDE_WIDTH}
            tabs={[
              ...(showAthena ? [{
                id: 'athena',
                label: 'Athena',
                dot: athenaBusy ? 'busy' as const : 'idle' as const,
                keepMounted: true,
                fill: true,
                content: <ThinkAthenaPanel pageContext={pageContext ?? undefined} onBusyChange={setAthenaBusy} />,
              }] : []),
              {
                id: 'details',
                label: 'Details',
                content: (
                  <div className="docs-info-panel docs-info-panel--embedded">
            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Title</p>
              <p className="docs-info-panel__value docs-info-panel__title">{selectedDoc.title}</p>
            </div>

            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Type</p>
              <Tag
                type="gray"
                size="sm"
              >
                {TYPE_LABEL[selectedDoc.type]}
              </Tag>
            </div>

            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Source</p>
              <p className="docs-info-panel__value">{selectedDoc.sourceLabel}</p>
            </div>

            {!selectedDocIsUpload && !selectedDocIsOneDrive && (
              <div className="docs-info-panel__section">
                <p className="docs-info-panel__label">Repository</p>
                <a
                  href={`https://github.com/${selectedDoc.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="docs-info-panel__link"
                >
                  {selectedDoc.repo}
                  <Launch size={12} />
                </a>
              </div>
            )}

            {selectedDoc.localPath !== undefined && (
              <div className="docs-info-panel__section">
                <p className="docs-info-panel__label">On {selectedDoc.deviceName ?? 'this PC'}</p>
                <code className="docs-info-panel__path">{selectedDoc.localPath}</code>
                {getDesktop() !== null && (
                  <button
                    type="button"
                    className="docs-info-panel__local-open"
                    onClick={() => {
                      const desktop = getDesktop();
                      if (desktop === null || selectedDoc.localPath === undefined) return;
                      desktop.showInFolder(selectedDoc.localPath).catch((err: unknown) => {
                        void alertDialog(desktopErrorMessage(err), { title: 'Could not show the file', tone: 'danger' });
                      });
                    }}
                  >
                    Show in folder
                  </button>
                )}
              </div>
            )}

            {!selectedDocIsOneDrive && selectedDoc.localPath === undefined && (
            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Path</p>
              <code className="docs-info-panel__path">{selectedDoc.path}</code>
            </div>
            )}

            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Size</p>
              <p className="docs-info-panel__value">{formatBytes(selectedDoc.size)}</p>
            </div>

            <div className="docs-info-panel__section docs-info-panel__section--tags">
              <p className="docs-info-panel__label">Tags</p>
              <div className="docs-info-panel__tags">
                {identitiesFor(identity, selectedDoc.taxonomyTagIds ?? []).map((t) => (
                  <IdentityChip key={t.tagId} identity={t} />
                ))}
                {(selectedDoc.taxonomyTagIds ?? []).length === 0 && (
                  <span className="docs-info-panel__value docs-info-panel__value--muted">None</span>
                )}
              </div>
              <TagPicker
                disabled={tagSaving}
                selectedIds={selectedDoc.taxonomyTagIds ?? []}
                onChange={(ids) => { void handleDocTagChange(ids); }}
                trigger={<button className="notes-tag-picker-trigger" disabled={tagSaving}>{tagSaving ? 'Saving tags...' : '+ Add tag'}</button>}
              />
            </div>

                  </div>
                ),
              },
              {
                id: 'connections',
                label: 'Connections',
                content: selectedDoc.contentItemId !== undefined
                  ? <ConnectionsPanel refId={selectedDoc.contentItemId} refType="document" headerless />
                  : <p className="docs-info-panel__value docs-info-panel__value--muted">Not in the knowledge graph yet.</p>,
              },
            ]}
          />
        )}

        </div>
      </div>

      {/* ── Upload dialog ── */}
      {uploadDialogOpen && (
        <div className="docs-upload-dialog-overlay">
          <div className="docs-upload-dialog">
            <h2 className="docs-upload-dialog__title">Upload Document</h2>
            <p className="docs-upload-dialog__subtitle">PDF, DOCX, XLSX, or PPTX files will be stored in Sources under the selected project and indexed automatically.</p>

            {/* File input */}
            <div className="docs-upload-dialog__section">
              <label className="docs-upload-dialog__label">File</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.pptx"
                onChange={handleFileSelect}
                disabled={uploadLoading}
                style={{ display: 'none' }}
              />
              <button
                className="docs-upload-dialog__file-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadLoading}
              >
                {fileInputRef.current?.files?.[0]?.name || 'Choose file…'}
              </button>
            </div>

            {/* Title input */}
            <div className="docs-upload-dialog__section">
              <label className="docs-upload-dialog__label">Title (optional)</label>
              <input
                type="text"
                className="docs-upload-dialog__input"
                placeholder="Document title"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                disabled={uploadLoading}
              />
            </div>

            <div className="docs-upload-dialog__section">
              <label className="docs-upload-dialog__label" htmlFor="docs-upload-project">Project</label>
              <select
                id="docs-upload-project"
                className="docs-upload-dialog__select"
                value={uploadProjectId}
                onChange={(e) => { setUploadProjectId(e.target.value); }}
                disabled={uploadLoading}
              >
                {!projectOptions.some((project) => project.id === 'personal') && <option value="personal">Personal / unassigned</option>}
                {projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </div>

            {/* Actions */}
            <div className="docs-upload-dialog__actions">
              <button
                className="docs-upload-dialog__btn docs-upload-dialog__btn--cancel"
                onClick={() => {
                  setUploadDialogOpen(false);
                  setUploadTitle('');
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                disabled={uploadLoading}
              >
                Cancel
              </button>
              <button
                className="docs-upload-dialog__btn docs-upload-dialog__btn--primary"
                onClick={() => {
                  const file = fileInputRef.current?.files?.[0];
                  if (file) handleUpload(file);
                }}
                disabled={uploadLoading || !fileInputRef.current?.files?.[0]}
              >
                {uploadLoading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
