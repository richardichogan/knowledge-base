/**
 * TimelinePage — all sources combined, rich card layout.
 * Date headers group items by day, cards show source-specific context.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  InlineLoading,
  InlineNotification,
  Tag,
  Toggle,
  Button,
} from '@carbon/react';
import { Launch, Renew, ChevronDown, ChevronUp } from '@carbon/icons-react';
import { api } from '../services/api';
import type { SourceStatus } from '../services/api';
import type { ContentItemSummary } from '../types';
import { inferProjectId, PROJECT_MAP, type Project } from '../config/projects';
import { useFlatTags } from '../hooks/useTaxonomy';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';

// ── Source metadata ───────────────────────────────────────────────────────────

interface SourceMeta {
  label: string;
  tagType: 'blue' | 'cyan' | 'teal' | 'purple' | 'green' | 'magenta' | 'warm-gray' | 'gray' | 'red';
  group: string;
}

const SOURCE_META: Record<string, SourceMeta> = {
  'cms-blog':               { label: 'Blog',         tagType: 'blue',      group: 'Content' },
  'cms-newsletter':         { label: 'Newsletter',   tagType: 'cyan',      group: 'Content' },
  'cms-podcast-show-notes': { label: 'Podcast',      tagType: 'teal',      group: 'Content' },
  'cms-session-summary':    { label: 'Session',      tagType: 'purple',    group: 'Content' },
  'github-commit':          { label: 'GH Commit',    tagType: 'green',     group: 'GitHub' },
  'github-pr':              { label: 'GH PR',        tagType: 'green',     group: 'GitHub' },
  'github-issue':           { label: 'GH Issue',     tagType: 'green',     group: 'GitHub' },
  'github-action':          { label: 'GH Action',    tagType: 'green',     group: 'GitHub' },
  'github-release':         { label: 'GH Release',   tagType: 'green',     group: 'GitHub' },
  'github-deployment':      { label: 'GH Deploy',    tagType: 'green',     group: 'GitHub' },
  'github-pr-review':       { label: 'GH Review',    tagType: 'green',     group: 'GitHub' },
  'gitlab-release':         { label: 'GL Release',   tagType: 'magenta',   group: 'GitLab' },
  'gitlab-deployment':      { label: 'GL Deploy',    tagType: 'magenta',   group: 'GitLab' },
  'gitlab-commit':          { label: 'GL Commit',    tagType: 'magenta',   group: 'GitLab' },
  'gitlab-mr':              { label: 'GL MR',        tagType: 'magenta',   group: 'GitLab' },
  'gitlab-issue':           { label: 'GL Issue',     tagType: 'magenta',   group: 'GitLab' },
  'gitlab-pipeline':        { label: 'Pipeline',     tagType: 'red',       group: 'GitLab' },
  'graph-calendar':         { label: 'Calendar',     tagType: 'warm-gray', group: 'Microsoft 365' },
  'graph-todo':             { label: 'To Do',        tagType: 'warm-gray', group: 'Microsoft 365' },
  'email':                  { label: 'Email',        tagType: 'warm-gray', group: 'Microsoft 365' },
  'note':                   { label: 'Note',         tagType: 'gray',      group: 'Notes' },
  'image':                  { label: 'Image',        tagType: 'gray',      group: 'Notes' },
  'discovered-article':     { label: 'Discovered',   tagType: 'cyan',      group: 'Content' },
};

const ALL_GROUPS = ['Content', 'GitHub', 'GitLab', 'Microsoft 365', 'Notes'];

function getMeta(source: string): SourceMeta {
  return SOURCE_META[source] ?? { label: source, tagType: 'gray', group: 'Other' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dayKey(iso: string): string { return iso.slice(0, 10); }

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Pull typed context out of metadata for richer display. */
function getSubtitle(item: ContentItemSummary): string | null {
  if (item.metadata == null) return null;
  const m = item.metadata as Record<string, unknown>;
  switch (item.source) {
    case 'gitlab-commit':
    case 'github-commit': {
      const short = typeof m['shortId'] === 'string' ? m['shortId']
        : typeof m['shortSha'] === 'string' ? m['shortSha'] : null;
      const author = typeof m['authorName'] === 'string' ? m['authorName']
        : typeof m['authorLogin'] === 'string' ? m['authorLogin'] : null;
      return [short ? `#${short}` : null, author ? `by ${author}` : null].filter(Boolean).join(' · ');
    }
    case 'gitlab-mr':
    case 'github-pr': {
      const state = typeof m['state'] === 'string' ? m['state'] : null;
      const author = typeof m['authorLogin'] === 'string' ? m['authorLogin']
        : typeof m['authorName'] === 'string' ? m['authorName'] : null;
      return [state, author ? `by ${author}` : null].filter(Boolean).join(' · ');
    }
    case 'gitlab-pipeline': {
      const branch = typeof m['ref'] === 'string' ? m['ref'] : null;
      const status = typeof m['status'] === 'string' ? m['status'] : null;
      return [branch ? `branch: ${branch}` : null, status].filter(Boolean).join(' · ');
    }
    case 'gitlab-issue':
    case 'github-issue': {
      const state = typeof m['state'] === 'string' ? m['state'] : null;
      const author = typeof m['authorLogin'] === 'string' ? m['authorLogin'] : null;
      return [state, author ? `by ${author}` : null].filter(Boolean).join(' · ');
    }
    case 'email': {
      const from = typeof m['from'] === 'string' ? m['from'] : null;
      const account = typeof m['accountLabel'] === 'string' ? m['accountLabel'] : null;
      return [from, account].filter(Boolean).join(' · ');
    }
    case 'cms-blog':
    case 'cms-newsletter':
    case 'cms-podcast-show-notes': {
      const cats = Array.isArray(m['categories']) ? (m['categories'] as string[]).slice(0, 3).join(', ') : null;
      return cats;
    }
    case 'note': {
      const tags = Array.isArray(m['tags']) && (m['tags'] as string[]).length > 0
        ? `Tags: ${(m['tags'] as string[]).join(', ')}` : null;
      return tags;
    }
    default:
      return null;
  }
}

/**
 * Get the project for a card using the projects config.
 * Returns null for 'personal' (default — no tag needed).
 */
function getProject(item: ContentItemSummary): { name: string; colour: Project['colour'] } | null {
  const id = inferProjectId(
    item.source,
    item.metadata as Record<string, unknown> | undefined,
    item.projectContext,
  );
  if (id === 'personal') return null;
  const project = PROJECT_MAP.get(id);
  return project != null ? { name: project.name, colour: project.colour } : null;
}

// ── Timeline card ─────────────────────────────────────────────────────────────

function mapSourceToRefType(source: string): string {
  if (source === 'note') return 'note';
  if (source === 'discovered-article') return 'discover_item';
  if (source === 'github-commit' || source === 'gitlab-commit') return 'commit';
  if (source === 'github-pr' || source === 'gitlab-mr') return 'pull_request';
  if (source === 'cms-blog') return 'blog_post';
  if (source === 'cms-podcast-show-notes') return 'podcast_episode';
  if (source === 'cms-newsletter') return 'newsletter';
  return source;
}

const TimelineCard: React.FC<{ item: ContentItemSummary }> = ({ item }) => {
  const [expanded, setExpanded] = useState(false);
  const flatTags = useFlatTags();
  const meta = getMeta(item.source);
  const subtitle = getSubtitle(item);
  const hasSummary = item.summary !== '' && item.summary !== item.title;
  const cmsTags = item.tags ?? [];
  const project = getProject(item);

  const taxonomyTags = (item.taxonomyTagIds ?? [])
    .map((id) => flatTags.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => t != null);

  return (
    <div className={`tl-card${expanded ? ' tl-card--expanded' : ''}`}>
      <div className="tl-card-main">
        {/* Left: time + source tag + project */}
        <div className="tl-card-left">
          <span className="tl-card-time">{formatTime(item.publishedAt)}</span>
          <Tag type={meta.tagType} size="sm">{meta.label}</Tag>
          {project != null && (
            <Tag type={project.colour} size="sm">{project.name}</Tag>
          )}
        </div>

        {/* Body */}
        <div className="tl-card-body">
          <span className="tl-card-title">{item.title}</span>
          {subtitle !== null && (
            <span className="tl-card-subtitle">{subtitle}</span>
          )}
          {/* Taxonomy tags (primary) + CMS tags (secondary) */}
          {(taxonomyTags.length > 0 || cmsTags.length > 0) && (
            <div className="tl-card-tags">
              {taxonomyTags.map((t) => (
                <span key={t.id} className="tl-taxonomy-pill" title={t.name}>
                  {t.colour && (
                    <span
                      className="tl-taxonomy-pill__swatch"
                      style={{ background: t.colour }}
                    />
                  )}
                  {t.name}
                </span>
              ))}
              {cmsTags.map((t) => (
                <Tag key={t} type="outline" size="sm">{t}</Tag>
              ))}
            </div>
          )}
          {/* Show full summary when expanded */}
          {expanded && hasSummary && (
            <p className="tl-card-summary">{item.summary}</p>
          )}
          {expanded && (
            <ConnectionsPanel refId={item.id} refType={mapSourceToRefType(item.source)} />
          )}
        </div>

        {/* Actions */}
        <div className="tl-card-actions">
          {hasSummary && (
            <button
              className="tl-card-expand"
              onClick={() => { setExpanded((e) => !e); }}
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
          {item.url != null && item.url !== '' && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="tl-card-link"
              title="Open source"
            >
              <Launch size={16} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

export const TimelinePage: React.FC<{ excludeSources?: string[] }> = ({ excludeSources }) => {
  const [enabledGroups, setEnabledGroups] = useState<Set<string>>(new Set(ALL_GROUPS));
  const [notification, setNotification] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const queryClient = useQueryClient();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSyncTsRef = useRef<number>(0);
  const loadPageRef = useRef<((p: number) => Promise<void>) | null>(null);
  const pageRef = useRef<number>(1);

  // Live sources query — refetches every 10s passively, every 5s while a sync is running
  const { data: sourcesData } = useQuery({
    queryKey: ['sources-status'],
    queryFn: () => api.getSources(),
    refetchInterval: isSyncing ? 5_000 : 10_000,
    staleTime: 0,
  });

  // Auto-refresh timeline when background scheduler completes a sync
  React.useEffect(() => {
    if (!sourcesData?.success) return;
    const latest = Math.max(0, ...sourcesData.data.map((s: SourceStatus) => new Date(s.lastSyncAt ?? 0).getTime()));
    if (lastSyncTsRef.current === 0) {
      lastSyncTsRef.current = latest;
      return;
    }
    if (latest > lastSyncTsRef.current) {
      lastSyncTsRef.current = latest;
      if (!isSyncing && loadPageRef.current) {
        void loadPageRef.current(pageRef.current);
      }
    }
  }, [sourcesData, isSyncing]);

  function stopPolling(): void {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  const syncMutation = useMutation({
    mutationFn: async () => {
      // Snapshot the most recent lastSyncAt before triggering, so we can
      // detect when the background job has actually finished.
      const before = await api.getSources();
      const beforeTs = before.success
        ? Math.max(0, ...before.data.map((s: SourceStatus) => new Date(s.lastSyncAt ?? 0).getTime()))
        : 0;
      await api.triggerSync();
      return beforeTs;
    },
    onSuccess: (beforeTs: number) => {
      setNotification({ kind: 'success', msg: 'Sync started — will refresh when complete…' });
      setIsSyncing(true);
      setSyncPanelOpen(true);
      stopPolling();

      const POLL_INTERVAL_MS = 5_000;
      const POLL_TIMEOUT_MS = 120_000;
      const started = Date.now();

      pollRef.current = setInterval(() => {
        void api.getSources().then((res) => {
          if (!res.success) return;
          void queryClient.invalidateQueries({ queryKey: ['sources-status'] });
          const latest = Math.max(0, ...res.data.map((s: SourceStatus) => new Date(s.lastSyncAt ?? 0).getTime()));
          const timedOut = Date.now() - started > POLL_TIMEOUT_MS;
          if (latest > beforeTs || timedOut) {
            stopPolling();
            setIsSyncing(false);
            void loadPage(1);
            void queryClient.invalidateQueries({ queryKey: ['sources-status'] });
            setNotification({ kind: 'success', msg: timedOut ? 'Sync timed out — timeline refreshed.' : 'Sync complete — timeline updated.' });
            setTimeout(() => { setNotification(null); }, 4_000);
          }
        });
      }, POLL_INTERVAL_MS);
    },
    onError: (err: unknown) => {
      stopPolling();
      setIsSyncing(false);
      setNotification({ kind: 'error', msg: `Sync failed: ${String(err)}` });
      setTimeout(() => { setNotification(null); }, 6_000);
    },
  });

  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  const [pageData, setPageData] = useState<{ items: ContentItemSummary[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await api.getTimeline({ page: p, pageSize: PAGE_SIZE });
      if (res.success) {
        setPageData({ items: res.data.items, total: res.data.total });
        setPage(p);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep refs in sync so the background-sync effect can call loadPage
  loadPageRef.current = loadPage;
  pageRef.current = page;

  React.useEffect(() => { void loadPage(1); }, [loadPage]);

  const filtered = (pageData?.items ?? [])
    .filter((item) => enabledGroups.has(getMeta(item.source).group))
    .filter((item) => !excludeSources?.includes(item.source));
  const total = pageData?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Group by day
  const byDay = new Map<string, ContentItemSummary[]>();
  for (const item of filtered) {
    const key = dayKey(item.publishedAt);
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  function toggleGroup(group: string): void {
    setEnabledGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) { next.delete(group); } else { next.add(group); }
      return next;
    });
  }

  return (
    <div className="page-root">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">My Work</h1>
        </div>
        <div className="page-controls">
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Renew}
            iconDescription="Sync now"
            onClick={() => { syncMutation.mutate(); }}
            disabled={syncMutation.isPending || isSyncing}
          >
            {isSyncing ? 'Syncing…' : 'Sync Now'}
          </Button>
          <Button
            kind="ghost"
            size="sm"
            renderIcon={syncPanelOpen ? ChevronUp : ChevronDown}
            iconDescription="Toggle sync status"
            onClick={() => { setSyncPanelOpen((v) => !v); }}
          >
            Sync Status
          </Button>
        </div>
      </div>

        {syncPanelOpen && (
          <div className="tl-sync-panel">
            <div className="tl-sync-panel__title">
              Source sync status
              {isSyncing && <InlineLoading description="Syncing…" className="tl-sync-panel__spinner" />}
            </div>
            <div className="tl-sync-panel__grid">
              {sourcesData?.success && sourcesData.data.map((s: SourceStatus) => {
                const hasError = Boolean(s.lastError);
                const neverSynced = s.lastSyncAt == null;
                return (
                  <div key={s.source} className={`tl-sync-row ${hasError ? 'tl-sync-row--error' : ''}`}>
                    <span className="tl-sync-row__source">{s.source}</span>
                    <span className="tl-sync-row__time">
                      {neverSynced ? '—' : new Date(s.lastSyncAt!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
                    </span>
                    <span className="tl-sync-row__count">{s.itemCount ?? 0} items</span>
                    {hasError && <span className="tl-sync-row__error" title={s.lastError ?? ''}>⚠ {s.lastError}</span>}
                  </div>
                );
              })}
              {(!sourcesData?.success) && <span className="tl-sync-loading">Loading…</span>}
            </div>
          </div>
        )}

        {notification !== null && (
          <InlineNotification
            kind={notification.kind}
            title={notification.msg}
            lowContrast
            onClose={() => { setNotification(null); }}
            className="tl-notification"
          />
        )}

        <div className="cal-filters">
          {ALL_GROUPS.map((group) => (
            <Toggle
              key={group}
              id={`tl-filter-${group}`}
              labelText={group}
              hideLabel={false}
              size="sm"
              toggled={enabledGroups.has(group)}
              onToggle={() => { toggleGroup(group); }}
              labelA=""
              labelB=""
            />
          ))}
        </div>

        {loading ? (
          <InlineLoading description="Loading timeline…" />
        ) : days.length === 0 ? (
          <InlineNotification kind="info" title="No activity" subtitle="No items match the selected filters." lowContrast />
        ) : (
          <>
            <div className="cal-day-list">
              {days.map(([day, items]) => (
                <div key={day} className="cal-day-group">
                  <div className="cal-day-header">
                    <span className="cal-day-label">{formatDay(day)}</span>
                    <span className="cal-day-count">{items.length} item{items.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="tl-card-list">
                    {items.map((item) => <TimelineCard key={item.id} item={item} />)}
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="tl-pagination">
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={() => { void loadPage(page - 1); }}
                  disabled={page <= 1 || loading}
                >
                  ← Previous
                </Button>
                <span className="tl-pagination__info">
                  Page {page} of {totalPages} &nbsp;·&nbsp; {total} items
                </span>
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={() => { void loadPage(page + 1); }}
                  disabled={page >= totalPages || loading}
                >
                  Next →
                </Button>
              </div>
            )}
          </>
        )}
    </div>
  );
};
