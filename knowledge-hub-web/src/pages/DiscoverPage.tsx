/**
 * DiscoverPage — AI-curated inbound article feed + CFP speaking opportunities.
 *
 * Articles discovered by the blog's RSS monitor are surfaced here with
 * GPT-4o-mini relevance scores. The user triages each article into one of:
 *   To Review (default) · Saved · Blog · Published · Archived
 *
 * CFPs (Calls for Papers) appear in their own tab — scored, sorted by deadline.
 */

import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Bookmark, Edit, Archive, Renew, Launch, ArrowRight, Link, Checkmark, Microphone } from '@carbon/icons-react';
import { api } from '../services/api';
import type { DiscoverItem, DiscoverWorkflowState, CfpItem, CfpWorkflowState } from '../services/api';
import type { ContentItemSummary } from '../types';
import { SparkCaptureButton } from '../components/sparks/SparkCaptureButton';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';
import { useFlatTags } from '../hooks/useTaxonomy';

// ── Config ────────────────────────────────────────────────────────────────────

type ActiveTab = DiscoverWorkflowState | 'inbox' | 'cfps';

interface TabDef {
  key: ActiveTab;
  label: string;
}

const STATE_TABS: TabDef[] = [
  { key: 'to-review',  label: 'To Review' },
  { key: 'saved',      label: 'Saved' },
  { key: 'blog',       label: 'Blog' },
  { key: 'published',  label: 'Published' },
  { key: 'archived',   label: 'Archived' },
  { key: 'cfps',       label: 'CFPs' },
  { key: 'inbox',      label: 'Inbox' },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function scoreLabel(score: number | null): string {
  if (score === null) return 'Unscored';
  return `${Math.round(score * 100)}% relevant`;
}

// ── CFP helpers ───────────────────────────────────────────────────────────────

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return 'Dates TBC';
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return end ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
}

function deadlineInfo(iso: string): { label: string; urgent: boolean } {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const label = days <= 0
    ? 'Deadline passed'
    : `Closes ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${days}d remaining`;
  return { label, urgent: days > 0 && days < 14 };
}

// ── CFP card component ────────────────────────────────────────────────────────

interface CfpCardProps {
  item: CfpItem;
  onStateChange: (id: string, state: CfpWorkflowState) => void;
  isUpdating: boolean;
}

const CfpCard: React.FC<CfpCardProps> = ({ item, onStateChange, isUpdating }) => {
  const deadline = deadlineInfo(item.cfpDeadline);
  const isToReview  = item.workflowState === 'to_review';
  const isSaved     = item.workflowState === 'saved';
  const isSubmitted = item.workflowState === 'submitted';

  return (
    <div className={`dc-card dc-card--cfp${isUpdating ? ' dc-card--updating' : ''}`}>
      <div className="dc-card-meta">
        <Microphone size={12} className="dc-cfp-icon" />
        <span className="dc-card-source">Speaking Opportunity</span>
        <span className="dc-card-dot">·</span>
        <span className="dc-card-source">{item.isVirtual ? 'Virtual' : (item.location ?? 'Location TBC')}</span>
        {item.relevanceScore !== null && (
          <span className="dc-relevance-badge">{scoreLabel(item.relevanceScore)}</span>
        )}
      </div>

      <div className="dc-card-title-row">
        <span className="dc-card-title">{item.conferenceName}</span>
        {item.eventUri !== null && (
          <a href={item.eventUri} target="_blank" rel="noreferrer" className="dc-card-ext-link" title="Conference website">
            <Launch size={14} />
          </a>
        )}
      </div>

      <div className="dc-cfp-dates">
        <span className="dc-cfp-event-dates">{formatDateRange(item.eventStart, item.eventEnd)}</span>
        <span className={`dc-cfp-deadline${deadline.urgent ? ' dc-cfp-deadline--urgent' : ''}`}>
          {deadline.label}
        </span>
      </div>

      {item.relevanceReason !== null && (
        <p className="dc-card-explanation">{item.relevanceReason}</p>
      )}

      <div className="dc-card-actions">
        {item.cfpUri && (
          <a href={item.cfpUri} target="_blank" rel="noreferrer" className="dc-action dc-action--ext">
            <Launch size={14} /> Submit
          </a>
        )}
        {isToReview && (
          <>
            <button className="dc-action dc-action--save" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'saved'); }}>
              <Bookmark size={14} /> Save
            </button>
            <button className="dc-action dc-action--blog" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'submitted'); }}>
              <Checkmark size={14} /> Submitted
            </button>
            <button className="dc-action dc-action--archive" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'archived'); }}>
              <Archive size={14} /> Archive
            </button>
          </>
        )}
        {isSaved && (
          <>
            <button className="dc-action dc-action--blog" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'submitted'); }}>
              <Checkmark size={14} /> Submitted
            </button>
            <button className="dc-action dc-action--archive" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'archived'); }}>
              <Archive size={14} /> Archive
            </button>
            <button className="dc-action dc-action--restore" disabled={isUpdating}
              onClick={() => { onStateChange(item.id, 'to_review'); }}>
              <Renew size={14} /> Back
            </button>
          </>
        )}
        {isSubmitted && (
          <button className="dc-action dc-action--restore" disabled={isUpdating}
            onClick={() => { onStateChange(item.id, 'to_review'); }}>
            <Renew size={14} /> Unsubmit
          </button>
        )}
        {item.workflowState === 'archived' && (
          <button className="dc-action dc-action--restore" disabled={isUpdating}
            onClick={() => { onStateChange(item.id, 'to_review'); }}>
            <ArrowRight size={14} /> Restore
          </button>
        )}
      </div>
    </div>
  );
};

const PublishedUrlEditor: React.FC<{ item: DiscoverItem }> = ({ item }) => {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(item.publishedUrl ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (url: string | null) => api.updateDiscoverPublishedUrl(item.id, url),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2000);
      void queryClient.invalidateQueries({ queryKey: ['discover'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Save failed');
    },
  });

  return (
    <div className="dc-published-url-editor">
      <label className="dc-published-url-label" htmlFor={`pub-url-${item.id}`}>
        Your blog post URL
      </label>
      <div className="dc-published-url-row">
        <input
          id={`pub-url-${item.id}`}
          className="dc-published-url-input"
          type="url"
          placeholder="https://yourblog.com/post…"
          value={value}
          onChange={(e) => { setValue(e.target.value); setSaved(false); }}
        />
        <button
          className={`dc-published-url-save${saved ? ' dc-published-url-save--ok' : ''}`}
          onClick={() => { mutation.mutate(value.trim() || null); }}
          disabled={mutation.isPending}
        >
          {saved ? <Checkmark size={14} /> : 'Save'}
        </button>
      </div>
      {item.publishedUrl !== null && value === item.publishedUrl && (
        <a
          href={item.publishedUrl}
          target="_blank"
          rel="noreferrer"
          className="dc-published-url-link"
        >
          <Launch size={12} /> View post
        </a>
      )}
      {error !== null && <span className="dc-published-url-error">{error}</span>}
    </div>
  );
};

// ── Card component ────────────────────────────────────────────────────────────

interface CardProps {
  item: DiscoverItem;
  onStateChange: (id: string, state: DiscoverWorkflowState) => void;
  isUpdating: boolean;
}

const DiscoverCard: React.FC<CardProps> = ({ item, onStateChange, isUpdating }) => {
  const isToReview  = item.workflowState === 'to-review';
  const isSaved     = item.workflowState === 'saved';
  const isBlog      = item.workflowState === 'blog';
  const isPublished = item.workflowState === 'published';
  const [copied, setCopied] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const flatTags = useFlatTags();
  const taxonomyTags = (item.taxonomyTagIds ?? [])
    .map((id) => flatTags.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

  function handleCopyUrl(): void {
    if (item.url === null) return;
    void navigator.clipboard.writeText(item.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onStateChange(item.id, 'published');
    });
  }

  return (
    <div className={`dc-card${isUpdating ? ' dc-card--updating' : ''}`}>
      <div className="dc-card-meta">
        <span className="dc-card-source">{item.sourceTitle}</span>
        <span className="dc-card-dot">·</span>
        <span className="dc-card-date">{formatDate(item.publishedAt)}</span>
        <span className="dc-relevance-badge">
          {scoreLabel(item.relevanceScore)}
        </span>
      </div>

      <div className="dc-card-title-row">
        <span className="dc-card-title">{item.title}</span>
        {item.url !== null && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="dc-card-ext-link"
            title="Open article"
            aria-label="Open article"
          >
            <Launch size={14} />
          </a>
        )}
      </div>

      {item.relevanceExplanation !== null && (
        <p className="dc-card-explanation">{item.relevanceExplanation}</p>
      )}

      {/* Published tab: show the blog URL editor */}
      {isPublished && <PublishedUrlEditor item={item} />}

      <div className="dc-card-actions">
        {/* Copy URL — shown on all cards that have a URL and aren't already published */}
        {item.url !== null && !isPublished && (
          <button
            className={`dc-action dc-action--copy${copied ? ' dc-action--copied' : ''}`}
            onClick={handleCopyUrl}
            disabled={isUpdating}
            title="Copy article URL and mark as published"
          >
            {copied ? <Checkmark size={14} /> : <Link size={14} />}
            {copied ? 'Copied!' : 'Copy URL'}
          </button>
        )}

        {isToReview && (
          <>
            <button
              className="dc-action dc-action--save"
              onClick={() => { onStateChange(item.id, 'saved'); }}
              disabled={isUpdating}
              title="Save for later"
            >
              <Bookmark size={14} /> Save
            </button>
            <button
              className="dc-action dc-action--blog"
              onClick={() => { onStateChange(item.id, 'blog'); }}
              disabled={isUpdating}
              title="Flag for blog post"
            >
              <Edit size={14} /> Blog
            </button>
            <button
              className="dc-action dc-action--archive"
              onClick={() => { onStateChange(item.id, 'archived'); }}
              disabled={isUpdating}
              title="Archive"
            >
              <Archive size={14} /> Archive
            </button>
          </>
        )}
        {isSaved && (
          <>
            <button
              className="dc-action dc-action--blog"
              onClick={() => { onStateChange(item.id, 'blog'); }}
              disabled={isUpdating}
              title="Move to Blog"
            >
              <Edit size={14} /> Move to Blog
            </button>
            <button
              className="dc-action dc-action--archive"
              onClick={() => { onStateChange(item.id, 'archived'); }}
              disabled={isUpdating}
              title="Archive"
            >
              <Archive size={14} /> Archive
            </button>
            <button
              className="dc-action dc-action--restore"
              onClick={() => { onStateChange(item.id, 'to-review'); }}
              disabled={isUpdating}
              title="Move back to To Review"
            >
              <Renew size={14} /> Back
            </button>
          </>
        )}
        {isBlog && (
          <>
            <button
              className="dc-action dc-action--restore"
              onClick={() => { onStateChange(item.id, 'saved'); }}
              disabled={isUpdating}
              title="Move back to Saved"
            >
              <Renew size={14} /> Unsave
            </button>
            <button
              className="dc-action dc-action--archive"
              onClick={() => { onStateChange(item.id, 'archived'); }}
              disabled={isUpdating}
              title="Archive"
            >
              <Archive size={14} /> Archive
            </button>
          </>
        )}
        {isPublished && (
          <button
            className="dc-action dc-action--restore"
            onClick={() => { onStateChange(item.id, 'to-review'); }}
            disabled={isUpdating}
            title="Move back to To Review"
          >
            <Renew size={14} /> Unpublish
          </button>
        )}
        {item.workflowState === 'archived' && (
          <button
            className="dc-action dc-action--restore"
            onClick={() => { onStateChange(item.id, 'to-review'); }}
            disabled={isUpdating}
            title="Restore to To Review"
          >
            <ArrowRight size={14} /> Restore
          </button>
        )}
        <SparkCaptureButton sourceId={item.id} sourceType="discover_item" />
        <button
          className={`dc-action dc-action--connections${connectionsOpen ? ' dc-action--connections-active' : ''}`}
          onClick={() => setConnectionsOpen((v) => !v)}
          title={connectionsOpen ? 'Hide connections' : 'Show connections'}
        >
          Connections
        </button>
      </div>
      {taxonomyTags.length > 0 && (
        <div className="dc-card-tags">
          {taxonomyTags.map((t) => (
            <span
              key={t.id}
              className="dc-taxonomy-pill"
              ref={(el) => { if (el && t.colour) el.style.setProperty('--pill-colour', t.colour); }}
            >
              {t.name}
            </span>
          ))}
        </div>
      )}
      {connectionsOpen && (
        <ConnectionsPanel refId={item.id} refType="discover_item" />
      )}
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

export const DiscoverPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('to-review');
  const [sourceFilter, setSourceFilter] = useState<string | undefined>(undefined);
  const [cfpStateFilter, setCfpStateFilter] = useState<CfpWorkflowState>('to_review');
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const isInbox = activeTab === 'inbox';
  const isCfps  = activeTab === 'cfps';
  const workflowState = isInbox ? 'to-review' : activeTab as DiscoverWorkflowState;

  const feedQuery = useQuery({
    queryKey: ['discover', workflowState, sourceFilter],
    queryFn: () => api.getDiscoverFeed(workflowState, sourceFilter),
    enabled: !isInbox && !isCfps,
  });

  const cfpQuery = useQuery({
    queryKey: ['cfps', cfpStateFilter],
    queryFn: () => api.getCfpItems(cfpStateFilter),
    staleTime: 60_000,
    enabled: isCfps,
  });

  const emailQuery = useQuery({
    queryKey: ['discover-emails'],
    queryFn: () => api.getTimeline({ source: 'email', pageSize: 50 }),
    staleTime: 60_000,
    enabled: isInbox,
  });

  const sourcesQuery = useQuery({
    queryKey: ['discover-sources'],
    queryFn: () => api.getDiscoverSources(),
    staleTime: 60_000,
  });

  const workflowMutation = useMutation({
    mutationFn: ({ id, state }: { id: string; state: DiscoverWorkflowState }) =>
      api.updateDiscoverWorkflow(id, state),
    onMutate: ({ id }) => {
      setUpdatingIds((prev) => new Set([...prev, id]));
    },
    onSettled: (_data, _err, { id }) => {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['discover'] });
    },
  });

  const cfpMutation = useMutation({
    mutationFn: ({ id, state }: { id: string; state: CfpWorkflowState }) =>
      api.updateCfpState(id, state),
    onMutate: ({ id }) => { setUpdatingIds((prev) => new Set([...prev, id])); },
    onSettled: (_data, _err, { id }) => {
      setUpdatingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      void queryClient.invalidateQueries({ queryKey: ['cfps'] });
    },
  });

  const handleStateChange = useCallback(
    (id: string, state: DiscoverWorkflowState) => {
      workflowMutation.mutate({ id, state });
    },
    [workflowMutation],
  );

  const handleCfpStateChange = useCallback(
    (id: string, state: CfpWorkflowState) => {
      cfpMutation.mutate({ id, state });
    },
    [cfpMutation],
  );

  const sources = feedQuery.data?.success ? [] : [];
  const allSources = sourcesQuery.data?.success ? sourcesQuery.data.data : [];
  void sources; // suppress unused warning — we use allSources

  const items: DiscoverItem[] =
    feedQuery.data?.success ? feedQuery.data.data.items : [];
  const total: number =
    feedQuery.data?.success ? feedQuery.data.data.total : 0;

  const activeTabDef = STATE_TABS.find((t) => t.key === activeTab) ?? STATE_TABS[0];

  return (
    <div className="page-root">
      <div className="page-header">
        <div>
          <h1 className="page-title">Discover</h1>
          <p className="page-subtitle">
            {isCfps
              ? `${(cfpQuery.data?.success ? cfpQuery.data.data : []).length} CFPs · ${cfpStateFilter.replace('_', ' ')}`
              : feedQuery.isLoading ? 'Loading…' : `${total} article${total !== 1 ? 's' : ''} · ${activeTabDef?.label ?? ''}`}
          </p>
        </div>
      </div>

      {/* State tabs */}
      <div className="dc-tabs">
        {STATE_TABS.map((tab) => (
          <button
            key={tab.key}
            className={`dc-tab${activeTab === tab.key ? ' dc-tab--active' : ''}`}
            onClick={() => { setActiveTab(tab.key); }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Source filter — only on article tabs */}
      {!isInbox && !isCfps && allSources.length > 0 && (
        <div className="dc-source-filters">
          <button
            className={`dc-source-chip${sourceFilter === undefined ? ' dc-source-chip--active' : ''}`}
            onClick={() => { setSourceFilter(undefined); }}
          >
            All sources
          </button>
          {allSources.map((s) => (
            <button
              key={s.title}
              className={`dc-source-chip${sourceFilter === s.title ? ' dc-source-chip--active' : ''}`}
              onClick={() => { setSourceFilter(s.title === sourceFilter ? undefined : s.title); }}
            >
              {s.title}
              <span className="dc-source-count">{s.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* CFP state filter — only on CFPs tab */}
      {isCfps && (
        <div className="dc-source-filters">
          {(['to_review', 'saved', 'submitted', 'archived'] as CfpWorkflowState[]).map((s) => (
            <button
              key={s}
              className={`dc-source-chip${cfpStateFilter === s ? ' dc-source-chip--active' : ''}`}
              onClick={() => { setCfpStateFilter(s); }}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      )}

      {/* CFPs feed */}
      {isCfps && (
        <div className="dc-feed">
          {cfpQuery.isLoading && <div className="dc-loading"><InlineLoading description="Loading CFPs…" /></div>}
          {!cfpQuery.isLoading && (cfpQuery.data?.success ? cfpQuery.data.data : []).length === 0 && (
            <div className="dc-empty"><p>No CFPs in <strong>{cfpStateFilter.replace('_', ' ')}</strong>.</p></div>
          )}
          {(cfpQuery.data?.success ? cfpQuery.data.data : []).map((cfp) => (
            <CfpCard
              key={cfp.id}
              item={cfp}
              onStateChange={handleCfpStateChange}
              isUpdating={updatingIds.has(cfp.id)}
            />
          ))}
        </div>
      )}

      {/* Articles feed */}
      {!isInbox && !isCfps && (
        <div className="dc-feed">
          {feedQuery.isLoading && (
            <div className="dc-loading">
              <InlineLoading description="Loading articles…" />
            </div>
          )}

          {feedQuery.isError && (
            <p className="dc-error">Failed to load articles. Check backend connection.</p>
          )}

          {!feedQuery.isLoading && !feedQuery.isError && items.length === 0 && (
            <div className="dc-empty">
              <p>No articles in <strong>{activeTabDef?.label}</strong>.</p>
            </div>
          )}

          {items.map((item) => (
            <DiscoverCard
              key={item.id}
              item={item}
              onStateChange={handleStateChange}
              isUpdating={updatingIds.has(item.id)}
            />
          ))}
        </div>
      )}

      {/* Inbox tab — emails */}
      {isInbox && (
        <div className="dc-feed">
          {emailQuery.isLoading && (
            <div className="dc-loading"><InlineLoading description="Loading emails…" /></div>
          )}
          {!emailQuery.isLoading && (emailQuery.data?.success ? emailQuery.data.data.items : []).length === 0 && (
            <div className="dc-empty"><p>No emails indexed.</p></div>
          )}
          {(emailQuery.data?.success ? emailQuery.data.data.items : []).map((email: ContentItemSummary) => {
            const meta = email.metadata as Record<string, unknown>;
            const from = typeof meta['from'] === 'string' ? meta['from'] : null;
            const account = typeof meta['accountLabel'] === 'string' ? meta['accountLabel'] : null;
            return (
              <div key={email.id} className="dc-email-card">
                <div className="dc-email-from">
                  {from ?? 'Unknown sender'}
                  {account !== null && <span className="dc-email-account">{account}</span>}
                </div>
                <div className="dc-email-subject">{email.title}</div>
                <div className="dc-email-date">{formatDate(email.publishedAt)}</div>
                {email.summary !== '' && email.summary !== email.title && (
                  <p className="dc-email-preview">{email.summary}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
