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
import { Document, Launch, ChevronDown, ChevronRight } from '@carbon/icons-react';
import { api } from '../services/api';
import type { DocEntry, DocType } from '../services/api';
import { PROJECTS } from '../config/projects';
import { TagPicker } from '../components/TagPicker';
import { useFlatTags, useTaxonomy } from '../hooks/useTaxonomy';

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

// ── DocCard component ─────────────────────────────────────────────────────────

const DocCard: React.FC<{
  doc: DocEntry;
  selectedId: string | null;
  onSelect: (id: string) => void;
}> = ({ doc, selectedId, onSelect }) => (
  <button
    className={`docs-list-item${selectedId === doc.id ? ' docs-list-item--active' : ''}`}
    onClick={() => { onSelect(doc.id); }}
  >
    <div className="docs-list-item__top">
      <span className="docs-list-item__title">{doc.title}</span>
      <span className="docs-type-badge">{TYPE_LABEL[doc.type]}</span>
    </div>
    <div className="docs-list-item__meta">
      <span className="docs-list-item__size">{formatBytes(doc.size)}</span>
    </div>
  </button>
);

// ── DocSection component ──────────────────────────────────────────────────────

const DocSection: React.FC<{
  label: string;
  colour?: string | null;
  count: number;
  children: React.ReactNode;
}> = ({ label, colour, count, children }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="docs-section">
      <button
        className="docs-section-header"
        onClick={() => { setOpen((o) => !o); }}
        aria-expanded={open}
        ref={(el) => { if (el && colour) el.style.setProperty('--section-colour', colour); }}
      >
        <span className="docs-section-chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {colour && <span className="docs-section-dot" />}
        <span className="docs-section-label">{label}</span>
        <span className="docs-section-count">{count}</span>
      </button>
      {open && <div className="docs-section-body">{children}</div>}
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

export const DocumentsPage: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [tagOverrides, setTagOverrides] = useState<Map<string, string[]>>(new Map());
  const qc = useQueryClient();

  const { data: libraryData, isPending: libraryPending } = useQuery({
    queryKey: ['documents-library'],
    queryFn: () => api.getDocumentLibrary(EXTRA_REPOS, REPO_LABELS),
    staleTime: 5 * 60_000,
  });

  const allDocs: DocEntry[] = useMemo(() => {
    const docs = libraryData?.success === true ? libraryData.data : [];
    return docs.map((d) => tagOverrides.has(d.id) ? { ...d, taxonomyTagIds: tagOverrides.get(d.id)! } : d);
  }, [libraryData, tagOverrides]);

  const flatTags = useFlatTags();
  const { data: taxonomyTree = [] } = useTaxonomy();

  // Derive a colour for each sourceLabel by fuzzy-matching against taxonomy tag names
  const sourceLabelColours = useMemo(() => {
    const map = new Map<string, string>();
    for (const doc of allDocs) {
      if (map.has(doc.sourceLabel)) continue;
      const lower = doc.sourceLabel.toLowerCase();
      const match = flatTags.find((t) =>
        lower.includes(t.name.toLowerCase()) ||
        t.name.toLowerCase().includes((lower.split(' ')[0]) ?? ''),
      );
      if (match?.colour) map.set(doc.sourceLabel, match.colour);
    }
    return map;
  }, [allDocs, flatTags]);

  // Group docs by sourceLabel (or flat list when searching)
  const grouped = useMemo(() => {
    const isSearching = searchQuery.trim() !== '';
    if (isSearching) {
      const q = searchQuery.toLowerCase();
      return {
        isSearching: true,
        flat: allDocs.filter((d) =>
          d.title.toLowerCase().includes(q) ||
          d.sourceLabel.toLowerCase().includes(q) ||
          d.path.toLowerCase().includes(q),
        ),
        sections: [] as Array<{ label: string; colour: string | null; docs: DocEntry[] }>,
      };
    }
    const sectionMap = new Map<string, DocEntry[]>();
    for (const doc of allDocs) {
      const arr = sectionMap.get(doc.sourceLabel) ?? [];
      arr.push(doc);
      sectionMap.set(doc.sourceLabel, arr);
    }
    const sections = [...sectionMap.entries()]
      .sort(([a], [b]) => {
        if (a === 'Content Store') return -1;
        if (b === 'Content Store') return 1;
        return a.localeCompare(b);
      })
      .map(([label, docs]) => ({
        label,
        colour: sourceLabelColours.get(label) ?? null,
        docs,
      }));
    return { isSearching: false, flat: [], sections };
  }, [allDocs, searchQuery, sourceLabelColours]);

  const selectedDoc = allDocs.find((d) => d.id === selectedId) ?? null;

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
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Library</h1>
          {allDocs.length > 0 && (
            <p className="page-subtitle">
              {allDocs.length} document{allDocs.length !== 1 ? 's' : ''}
              {searchQuery.trim() !== '' && ` · ${grouped.flat.length} shown`}
            </p>
          )}
        </div>
      </div>

      <div className="docs-body">

        {/* ── Left: grouped document list ── */}
        <div className="docs-list-panel">
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
            {grouped.isSearching ? (
              <>
                {grouped.flat.map((doc) => (
                  <DocCard key={doc.id} doc={doc} selectedId={selectedId} onSelect={setSelectedId} />
                ))}
                {grouped.flat.length === 0 && (
                  <p className="docs-empty">No documents match "{searchQuery}"</p>
                )}
              </>
            ) : (
              <>
                {grouped.sections.map(({ label, colour, docs }) => (
                  <DocSection key={label} label={label} colour={colour} count={docs.length}>
                    {docs.map((doc) => (
                      <DocCard key={doc.id} doc={doc} selectedId={selectedId} onSelect={setSelectedId} />
                    ))}
                  </DocSection>
                ))}
                {!libraryPending && grouped.sections.length === 0 && (
                  <p className="docs-empty">No documents found.</p>
                )}
              </>
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
