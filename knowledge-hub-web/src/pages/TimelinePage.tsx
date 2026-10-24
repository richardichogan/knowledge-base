/**
 * TimelinePage — all sources combined, rich card layout.
 * Date headers group items by day, cards show source-specific context.
 */

import React, { useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  InlineLoading,
  InlineNotification,
  Toggle,
  Button,
} from '@carbon/react';
import { Launch, Renew, ChevronDown, ChevronUp } from '@carbon/icons-react';
import { api } from '../services/api';
import type { Project, SourceStatus } from '../services/api';
import type { ContentItemSummary } from '../types';
import { inferProjectId } from '../utils/projectMatching';
import { contentTypeIcon, EntityChip, IdentityChip, identitiesFor, useIdentity } from '../identity';
import { useProjects } from '../hooks/useProjects';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';
import { EmailAccountConnections } from '../components/EmailAccountConnections';
import { ConnectionTokens } from '../components/ConnectionTokens';
import { MuralIntegration } from '../components/MuralIntegration';
import { ShareEmailSettings } from '../components/ShareEmailSettings';
import { requireApiData, requireApiSuccess, describeApiError } from '../services/apiError';
import { pollSyncRun } from '../services/syncPolling';
import { DataNotice } from '../components/DataNotice';
import { PageHeader } from '../components/PageHeader';
import { AppDialog } from '../components/AppDialog';

// ── Source metadata ───────────────────────────────────────────────────────────

interface SourceMeta {
  label: string;
  contentType: string;
  group: string;
}

const SOURCE_META: Record<string, SourceMeta> = {
  'cms-blog':               { label: 'Blog',       contentType: 'blog',       group: 'Content' },
  'cms-newsletter':         { label: 'Newsletter', contentType: 'newsletter', group: 'Content' },
  'cms-podcast-show-notes': { label: 'Podcast',    contentType: 'podcast',    group: 'Content' },
  'cms-session-summary':    { label: 'Session',    contentType: 'meeting',    group: 'Content' },
  'github-commit':          { label: 'GH Commit',  contentType: 'code',       group: 'GitHub' },
  'github-pr':              { label: 'GH PR',      contentType: 'task',       group: 'GitHub' },
  'github-issue':           { label: 'GH Issue',   contentType: 'task',       group: 'GitHub' },
  'github-action':          { label: 'GH Action',  contentType: 'code',       group: 'GitHub' },
  'github-release':         { label: 'GH Release', contentType: 'spec',       group: 'GitHub' },
  'github-deployment':      { label: 'GH Deploy',  contentType: 'code',       group: 'GitHub' },
  'github-pr-review':       { label: 'GH Review',  contentType: 'task',       group: 'GitHub' },
  'gitlab-release':         { label: 'GL Release', contentType: 'spec',       group: 'GitLab' },
  'gitlab-deployment':      { label: 'GL Deploy',  contentType: 'code',       group: 'GitLab' },
  'gitlab-commit':          { label: 'GL Commit',  contentType: 'code',       group: 'GitLab' },
  'gitlab-mr':              { label: 'GL MR',      contentType: 'task',       group: 'GitLab' },
  'gitlab-issue':           { label: 'GL Issue',   contentType: 'task',       group: 'GitLab' },
  'gitlab-pipeline':        { label: 'Pipeline',   contentType: 'code',       group: 'GitLab' },
  'graph-calendar':         { label: 'Calendar',   contentType: 'meeting',    group: 'Microsoft 365' },
  'graph-todo':             { label: 'To Do',      contentType: 'task',       group: 'Microsoft 365' },
  'email':                  { label: 'Email',      contentType: 'chat',       group: 'Microsoft 365' },
  'note':                   { label: 'Note',       contentType: 'note',       group: 'Notes' },
  'image':                  { label: 'Image',      contentType: 'spec',       group: 'Notes' },
  'discovered-article':     { label: 'Discovered', contentType: 'research',   group: 'Content' },
};

const ALL_GROUPS = ['Content', 'GitHub', 'GitLab', 'Microsoft 365', 'Notes'];

function getMeta(source: string): SourceMeta {
  return SOURCE_META[source] ?? { label: source, contentType: 'note', group: 'Other' };
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
 * Get the project for a card using the canonical API project records.
 * Returns null for 'personal' (default — no tag needed).
 */
function getProject(item: ContentItemSummary, projects: readonly Project[]): Project | null {
  const id = inferProjectId(
    item.metadata != null ? item.metadata as Record<string, unknown> : undefined,
    item.projectContext,
    projects,
  );
  if (id === 'personal') return null;
  return projects.find((project) => project.id === id) ?? null;
}

// ── Timeline card ─────────────────────────────────────────────────────────────

function mapSourceToRefType(source: string): string {
  if (source === 'note') return 'note';
  if (source === 'discovered-article') return 'discover_item';
  if (source === 'github-commit' || source === 'gitlab-commit') return 'commit';
  if (source === 'github-pr' || source === 'gitlab-mr') return 'pull_request';
  if (source === 'github-issue' || source === 'gitlab-issue') return 'issue';
  if (source.startsWith('github-') && source !== 'github-doc' && source !== 'github-content-store') return 'github_item';
  if (source === 'cms-blog') return 'blog_post';
  if (source === 'cms-podcast-show-notes') return 'podcast_episode';
  if (source === 'cms-newsletter') return 'newsletter';
  return source;
}

const TimelineCard: React.FC<{ item: ContentItemSummary; projects: readonly Project[] }> = ({ item, projects }) => {
  const [expanded, setExpanded] = useState(false);
  const identity = useIdentity();
  const meta = getMeta(item.source);
  const SourceIcon = contentTypeIcon(meta.contentType);
  const subtitle = getSubtitle(item);
  const hasSummary = item.summary !== '' && item.summary !== item.title;
  const project = getProject(item, projects);
  // Source labels in item.tags are system metadata, not themes — only the taxonomy is shown.
  const taxonomyTags = identitiesFor(identity, item.taxonomyTagIds ?? [], project?.id);

  return (
    <div className={`tl-card${expanded ? ' tl-card--expanded' : ''}`}>
      <div className="tl-card-main">
        {/* Left: time + source tag + project */}
        <div className="tl-card-left">
          <span className="tl-card-time">{formatTime(item.publishedAt)}</span>
          <span className="kh-type-mark"><SourceIcon size={14} aria-hidden="true" />{meta.label}</span>
          {project != null && (
            <EntityChip projectId={project.id} name={project.name} fallbackLabel={project.name} />
          )}
        </div>

        {/* Body */}
        <div className="tl-card-body">
          <span className="tl-card-title">{item.title}</span>
          {subtitle !== null && (
            <span className="tl-card-subtitle">{subtitle}</span>
          )}
          {taxonomyTags.length > 0 && (
            <div className="tl-card-tags kh-chip-row">
              {taxonomyTags.map((t) => <IdentityChip key={t.tagId} identity={t} />)}
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

export const TimelinePage: React.FC<{ excludeSources?: string[]; settingsOnly?: boolean }> = ({ excludeSources, settingsOnly = false }) => {
  const { data: projects = [] } = useProjects();
  const [enabledGroups, setEnabledGroups] = useState<Set<string>>(new Set(ALL_GROUPS));
  const [notification, setNotification] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const syncPending = useRef(false);
  const queryClient = useQueryClient();
  const pollRef = useRef<AbortController | null>(null);
  const lastSyncRunRef = useRef<string | null>(null);
  const loadPageRef = useRef<((p: number) => Promise<void>) | null>(null);
  const pageRef = useRef<number>(1);

  // Live sources query — refetches every 10s passively, every 5s while a sync is running
  const { data: sourcesData, error: sourcesError, refetch: retrySources } = useQuery({
    queryKey: ['sources-status'],
    queryFn: async () => requireApiSuccess(await api.getSources()),
    refetchInterval: isSyncing ? 5_000 : 10_000,
    staleTime: 0,
  });

  const { data: latestRun, error: runError, refetch: retryRun } = useQuery({
    queryKey: ['sync-run-latest'],
    queryFn: async () => requireApiData(await api.getLatestSyncRun()),
    refetchInterval: 10_000,
  });

  // Refresh only on a completed run identity, not one source's timestamp.
  React.useEffect(() => {
    if (!latestRun || latestRun.status === 'running' || lastSyncRunRef.current === latestRun.id) return;
    const previous = lastSyncRunRef.current;
    lastSyncRunRef.current = latestRun.id;
    if (previous !== null && !isSyncing) void loadPageRef.current?.(pageRef.current);
  }, [latestRun, isSyncing]);

  function stopPolling(): void {
    if (pollRef.current !== null) {
      pollRef.current.abort();
      pollRef.current = null;
    }
  }
  React.useEffect(() => () => { stopPolling(); }, []);

  const syncMutation = useMutation({
    mutationFn: async () => {
      return requireApiData(await api.triggerSync());
    },
    onSuccess: (startedRun) => {
      setNotification({ kind: 'success', msg: 'Sync started — will refresh when complete…' });
      setIsSyncing(true);
      setSyncPanelOpen(true);
      stopPolling();

      const controller = new AbortController();
      pollRef.current = controller;
      void pollSyncRun(async (signal) => requireApiData(await api.getSyncRun(startedRun.id, signal)), controller.signal)
        .then((run) => {
          if (controller.signal.aborted) return;
          setNotification({ kind: run.status === 'succeeded' ? 'success' : 'error',
            msg: run.status === 'succeeded' ? 'Sync complete — timeline updated.'
              : `Sync ${run.status} — inspect source results. No automatic rerun was started.` });
          void loadPage(1);
          void queryClient.invalidateQueries({ queryKey: ['sources-status'] });
          void queryClient.invalidateQueries({ queryKey: ['sync-run-latest'] });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setNotification({ kind: 'error', msg: describeApiError(error) });
        })
        .finally(() => {
          if (pollRef.current === controller) { pollRef.current = null; syncPending.current = false; setIsSyncing(false); }
        });
    },
    onError: (err: unknown) => {
      stopPolling();
      syncPending.current = false;
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
    if (settingsOnly) return;
    setLoading(true);
    try {
      const data = requireApiData(await api.getTimeline({ page: p, pageSize: PAGE_SIZE }));
      setPageData({ items: data.items, total: data.total });
      setPage(p);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setNotification({ kind: 'error', msg: `Timeline could not be refreshed: ${describeApiError(error)}` });
    } finally {
      setLoading(false);
    }
  }, [settingsOnly]);

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

  const syncButton = <Button
            kind="ghost"
            size="sm"
            renderIcon={Renew}
            iconDescription="Sync now"
            onClick={() => {
              if (syncPending.current) return;
              syncPending.current = true;
              syncMutation.mutate();
            }}
            disabled={syncMutation.isPending || isSyncing}
          >
            {isSyncing ? 'Syncing…' : 'Sync Now'}
          </Button>;
  const syncContent = <div className="tl-sync-panel">
            <Link className="tl-sync-jobs-link" to="/jobs?jobId=a7000000-0000-4000-8000-000000000001">Manage sync schedule and audit history in Jobs</Link>
            <MuralIntegration />
            <ShareEmailSettings />
            <ConnectionTokens />
            <EmailAccountConnections />
            {sourcesError !== null && <DataNotice title="Source status is unavailable" error={sourcesError} onRetry={() => { void retrySources(); }} />}
            {runError !== null && <DataNotice title="Sync run status is unavailable" error={runError} onRetry={() => { void retryRun(); }} />}
            {latestRun !== null && latestRun !== undefined && <section className="tl-sync-run" aria-label="Latest sync run">
              <h3 className="tl-sync-run__heading">Latest run: {latestRun.status}</h3>
              <p className="tl-sync-run__meta">{formatTime(latestRun.startedAt)} · {latestRun.id}</p>
              <ul className="tl-sync-run__results">
                {latestRun.results.map(result => <li key={result.source} className={result.errors > 0 ? 'tl-sync-run__result--error' : ''}>
                  <span>{result.source}</span><span>{result.indexed} indexed · {result.errors} errors</span>
                </li>)}
              </ul>
            </section>}
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
              {(!sourcesData?.success) && sourcesError === null && <span className="tl-sync-loading">Loading…</span>}
            </div>
          </div>;

  const notice = notification !== null && (
          <InlineNotification
            kind={notification.kind}
            title={notification.msg}
            lowContrast
            onClose={() => { setNotification(null); }}
            className="tl-notification"
          />
        );

  if (settingsOnly) return <div className="kh-settings-connections">
    <div className="kh-settings-toolbar">{syncButton}</div>
    {notice}
    {syncContent}
  </div>;

  return (
    <div className="page-root" role="main">
      <PageHeader title="Activity" actions={<>
        {syncButton}
        <Button kind="ghost" size="sm" onClick={() => { setSyncPanelOpen(true); }}>
          Connections and sync
        </Button>
      </>} />
      {syncPanelOpen && <AppDialog title="Connections and sync" settings
        onClose={() => { setSyncPanelOpen(false); }} actions={
          <button type="button" className="kh-dialog__button" onClick={() => { setSyncPanelOpen(false); }}>Done</button>
        }>
        <div className="kh-settings-toolbar">{syncButton}</div>
        {notice}
        {syncContent}
      </AppDialog>}
      {!syncPanelOpen && notice}

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
                    {items.map((item) => <TimelineCard key={item.id} item={item} projects={projects} />)}
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
