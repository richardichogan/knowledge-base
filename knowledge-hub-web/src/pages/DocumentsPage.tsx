/**
 * DocumentsPage — document library.
 *
 * Surfaces formal markdown artifacts from two sources:
 *   1. richardichogan/content-store  — blog drafts, specs, newsletters, etc.
 *   2. /docs folders in project repos — project documentation
 *
 * Left panel  — flat document list, filtered by tags.
 * Right panel — read-only markdown viewer with View on GitHub link.
 *
 * No repo dropdown. No file tree. The library is the navigation.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading, Tag } from '@carbon/react';
import { Document, Launch } from '@carbon/icons-react';
import { api } from '../services/api';
import type { DocEntry, DocType } from '../services/api';
import { PROJECTS } from '../config/projects';
import { TagPicker } from '../components/TagPicker';
import { useFlatTags, useTaxonomy, expandTagIds } from '../hooks/useTaxonomy';

// ── Source config ─────────────────────────────────────────────────────────────

// Build the extra repos list and label map from project config
const PROJECT_REPOS = PROJECTS.filter((p) => p.githubRepos && p.githubRepos.length > 0);

const EXTRA_REPOS: string[] = PROJECT_REPOS.flatMap((p) => p.githubRepos ?? []);

const REPO_LABELS: Record<string, string> = {};
for (const p of PROJECT_REPOS) {
  for (const repo of p.githubRepos ?? []) {
    REPO_LABELS[repo] = p.name;
  }
}

// ── Type badge config ─────────────────────────────────────────────────────────

const TYPE_LABEL: Record<DocType, string> = {
  'blog-draft': 'Blog draft',
  spec: 'Spec',
  newsletter: 'Newsletter',
  readme: 'README',
  doc: 'Doc',
};

const TYPE_TAG_COLOR: Record<DocType, string> = {
  'blog-draft': 'blue',
  spec: 'purple',
  newsletter: 'teal',
  readme: 'warm-gray',
  doc: 'cyan',
};

// ── Markdown renderer ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCode = false;
  let inList = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inList) { html.push('</ul>'); inList = false; }
      if (inCode) { html.push('</code></pre>'); inCode = false; }
      else { html.push(`<pre><code class="language-${escapeHtml(line.slice(3).trim())}">`); inCode = true; }
      continue;
    }
    if (inCode) { html.push(escapeHtml(line)); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push('<hr />'); continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h${hm[1]!.length}>${inlineMarkdown(hm[2] ?? '')}</h${hm[1]!.length}>`); continue;
    }
    if (line.startsWith('> ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`); continue;
    }
    const li = line.match(/^[-*+]\s+(.+)/);
    if (li) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inlineMarkdown(li[1] ?? '')}</li>`); continue;
    }
    if (line.trim() === '') {
      if (inList) { html.push('</ul>'); inList = false; }
      continue;
    }
    if (inList) { html.push('</ul>'); inList = false; }
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  if (inList) html.push('</ul>');
  if (inCode) html.push('</code></pre>');
  return html.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Local tag storage ─────────────────────────────────────────────────────────
// ── Page ──────────────────────────────────────────────────────────────────────

export const DocumentsPage: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  // Optimistic overrides: docId → tagIds (updated immediately on change before refetch)
  const [tagOverrides, setTagOverrides] = useState<Map<string, string[]>>(new Map());
  const qc = useQueryClient();

  // ── Fetch unified library ──────────────────────────────────────────────────
  const { data: libraryData, isPending: libraryPending } = useQuery({
    queryKey: ['documents-library'],
    queryFn: () => api.getDocumentLibrary(EXTRA_REPOS, REPO_LABELS),
    staleTime: 5 * 60_000,
  });

  const allDocs: DocEntry[] = useMemo(() => {
    const docs = libraryData?.success === true ? libraryData.data : [];
    // Apply optimistic tag overrides
    return docs.map((d) => tagOverrides.has(d.id) ? { ...d, taxonomyTagIds: tagOverrides.get(d.id)! } : d);
  }, [libraryData, tagOverrides]);

  // Taxonomy hooks
  const { data: taxonomyTree = [] } = useTaxonomy();
  const flatTags = useFlatTags();

  // Filter by active taxonomy tag IDs + search query
  const visibleDocs = useMemo(() => {
    let docs = activeTagIds.size === 0
      ? allDocs
      : allDocs.filter((doc) => {
          const docTagIds = doc.taxonomyTagIds ?? [];
          // For each selected tag, expand to include its children
          return [...activeTagIds].some((selectedId) => {
            const matchIds = expandTagIds(selectedId, taxonomyTree);
            return docTagIds.some((id) => matchIds.has(id));
          });
        });
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      docs = docs.filter((doc) =>
        doc.title.toLowerCase().includes(q) ||
        doc.sourceLabel.toLowerCase().includes(q) ||
        doc.path.toLowerCase().includes(q),
      );
    }
    return docs;
  }, [allDocs, activeTagIds, searchQuery, taxonomyTree]);

  function toggleTagId(id: string): void {
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectedDoc = allDocs.find((d) => d.id === selectedId) ?? null;

  // ── Tag save handler ───────────────────────────────────────────────────────
  const handleDocTagChange = useCallback(async (ids: string[]) => {
    if (!selectedDoc) return;
    setTagOverrides((prev) => new Map([...prev, [selectedDoc.id, ids]]));
    try {
      await api.setDocumentTags(selectedDoc.id, ids);
      void qc.invalidateQueries({ queryKey: ['documents-library'] });
    } catch {
      setTagOverrides((prev) => {
        const next = new Map(prev);
        next.delete(selectedDoc.id);
        return next;
      });
    }
  }, [selectedDoc, qc]);

  // ── Fetch selected document content ───────────────────────────────────────
  const { data: contentData, isPending: contentPending } = useQuery({
    queryKey: ['document-content', selectedDoc?.repo, selectedDoc?.path],
    queryFn: () => api.getDocumentContent(selectedDoc!.repo, selectedDoc!.path),
    enabled: selectedDoc !== null,
    staleTime: 10 * 60_000,
  });

  const renderedHtml = useMemo(() => {
    if (contentData?.success !== true) return '';
    return renderMarkdown(contentData.data.content);
  }, [contentData]);

  return (
    <div className="docs-page">
      {/* ── Header ── */}
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Library</h1>
          {allDocs.length > 0 && (
            <p className="page-subtitle">
              {allDocs.length} document{allDocs.length !== 1 ? 's' : ''}
              {(activeTagIds.size > 0 || searchQuery.trim() !== '') && ` · ${visibleDocs.length} shown`}
            </p>
          )}
        </div>
      </div>

      {/* ── Three-panel body ── */}
      <div className="docs-body">

        {/* ── Left: document list ── */}
        <div className="docs-list-panel">

          {/* Taxonomy tag filter */}
          {taxonomyTree.length > 0 && (
            <div className="docs-tag-filter">
              {taxonomyTree.map((parent) => (
                <button
                  key={parent.id}
                  className={`docs-tag-chip${activeTagIds.has(parent.id) ? ' docs-tag-chip--active' : ''}`}
                  onClick={() => { toggleTagId(parent.id); }}
                  ref={(el) => { if (el && parent.colour) el.style.setProperty('--chip-colour', parent.colour); }}
                >
                  {parent.name}
                </button>
              ))}
            </div>
          )}

          {/* Search */}
          <div className="docs-search">
            <input
              type="search"
              className="docs-search__input"
              placeholder="Search documents…"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); }}
            />
          </div>

          {libraryPending && <InlineLoading description="Loading documents…" className="docs-loading" />}

          <div className="docs-list">
            {visibleDocs.map((doc) => (
              <button
                key={doc.id}
                className={`docs-list-item${selectedId === doc.id ? ' docs-list-item--active' : ''}`}
                onClick={() => { setSelectedId(doc.id); }}
              >
                <div className="docs-list-item__top">
                  <span className="docs-list-item__title">{doc.title}</span>
                  <span className="docs-type-badge">
                    {TYPE_LABEL[doc.type]}
                  </span>
                </div>
                <div className="docs-list-item__meta">
                  <span className="docs-list-item__source">{doc.sourceLabel}</span>
                  <span className="docs-list-item__size">{formatBytes(doc.size)}</span>
                </div>
              </button>
            ))}

            {!libraryPending && visibleDocs.length === 0 && (
              <p className="docs-empty">
                {activeTagIds.size > 0 ? 'No documents match the selected tags.' : 'No documents found.'}
              </p>
            )}
          </div>
        </div>

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

          {selectedDoc !== null && !contentPending && contentData?.success === true && (
            <>
              <div className="docs-viewer__toolbar">
                <div className="docs-viewer__file-info">
                  <Tag
                    // @ts-expect-error Carbon Tag type union is too wide
                    type={TYPE_TAG_COLOR[selectedDoc.type]}
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
                  View on GitHub
                </a>
              </div>
              <div
                className="docs-viewer__content"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            </>
          )}
        </div>

        {/* ── Right: document info panel ── */}
        {selectedDoc !== null && (
          <div className="docs-info-panel">
            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Title</p>
              <p className="docs-info-panel__value docs-info-panel__title">{selectedDoc.title}</p>
            </div>

            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Type</p>
              <Tag
                // @ts-expect-error Carbon Tag type union is too wide
                type={TYPE_TAG_COLOR[selectedDoc.type]}
                size="sm"
              >
                {TYPE_LABEL[selectedDoc.type]}
              </Tag>
            </div>

            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Source</p>
              <p className="docs-info-panel__value">{selectedDoc.sourceLabel}</p>
            </div>

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

            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Path</p>
              <code className="docs-info-panel__path">{selectedDoc.path}</code>
            </div>

            <div className="docs-info-panel__section">
              <p className="docs-info-panel__label">Size</p>
              <p className="docs-info-panel__value">{formatBytes(selectedDoc.size)}</p>
            </div>

            <div className="docs-info-panel__section docs-info-panel__section--tags">
              <p className="docs-info-panel__label">Tags</p>
              <div className="docs-info-panel__tags">
                {(selectedDoc.taxonomyTagIds ?? []).map((tagId) => {
                  const tag = flatTags.find((t) => t.id === tagId);
                  if (!tag) return null;
                  return (
                    <span
                      key={tagId}
                      className="docs-info-tag"
                      style={{ background: tag.colour ?? undefined }}
                    >
                      {tag.name}
                    </span>
                  );
                })}
                {(selectedDoc.taxonomyTagIds ?? []).length === 0 && (
                  <span className="docs-info-panel__value docs-info-panel__value--muted">None</span>
                )}
              </div>
              <TagPicker
                selectedIds={selectedDoc.taxonomyTagIds ?? []}
                onChange={(ids) => { void handleDocTagChange(ids); }}
                trigger={<button className="notes-tag-picker-trigger">+ Add tag</button>}
              />
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
