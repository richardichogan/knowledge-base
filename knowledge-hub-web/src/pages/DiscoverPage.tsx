/**
 * DiscoverPage — AI-curated inbound article feed + CFP speaking opportunities.
 *
 * Articles Athena discovers from its feeds (managed under Sources) are surfaced here with
 * weighted ranking scores; ones left unactioned for a week are shelved. The user triages each article into one of:
 *   To Review (default) · Shelved · Saved · Blog · Published · Archived
 *
 * CFPs (Calls for Papers) appear in their own tab — scored, sorted by deadline.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Bookmark, Edit, Archive, Renew, Launch, ArrowRight, Link, Checkmark, Microphone, Diagram, Search, Close } from '@carbon/icons-react';
import { api } from '../services/api';
import { requireApiData, requireApiSuccess } from '../services/apiError';
import { DataNotice } from '../components/DataNotice';
import type { DiscoverItem, DiscoverWorkflowState, CfpItem, CfpWorkflowState } from '../services/api';
import type { ContentItemSummary } from '../types';
import { SparkCaptureButton } from '../components/sparks/SparkCaptureButton';
import { copyItemToCanvas } from '../features/canvas/canvasClipboard';
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel';
import { DiscoverActions } from '../components/discover/DiscoverActions';
import { DiscoverSources } from '../components/discover/DiscoverSources';
import { useFlatTags } from '../hooks/useTaxonomy';
import { useAthenaContext } from '../context/AthenaContext';
import { BlogPublishModal } from '../components/discover/BlogPublishModal';
import { LinkedInDraftModal } from '../components/discover/LinkedInDraftModal';
import { ProjectFitChips } from '../components/discover/ProjectFitChips';
import { DiscoverReview } from '../components/discover/DiscoverReview';
import { SavedViews } from '../components/SavedViews';
import { DEFAULT_DISCOVER_VIEW, DISCOVER_PREFERENCES_KEY, parseWorkspaceView, type DiscoverPreferences, type DiscoverTab } from '../utils/savedViews';

// ── Config ────────────────────────────────────────────────────────────────────

type ActiveTab = DiscoverTab;

interface TabDef {
  key: ActiveTab;
  label: string;
}

const STATE_TABS: TabDef[] = [
  { key: 'to-review',  label: 'To Review' },
  { key: 'shelved',    label: 'Shelved' },
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

/** Colour band for the relevance badge on each card. */
function scoreTier(score: number | null): 'high' | 'mid' | 'low' {
  if (score === null) return 'low';
  return score >= 0.75 ? 'high' : score >= 0.5 ? 'mid' : 'low';
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
  const savePending = useRef(false);

  const mutation = useMutation({
    mutationFn: async (url: string | null) => requireApiData(await api.updateDiscoverPublishedUrl(item.id, url)),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 2000);
      void queryClient.invalidateQueries({ queryKey: ['discover'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Save failed');
    },
    onSettled: () => { savePending.current = false; },
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
          disabled={mutation.isPending}
          onChange={(e) => { setValue(e.target.value); setSaved(false); }}
        />
        <button
          className={`dc-published-url-save${saved ? ' dc-published-url-save--ok' : ''}`}
          onClick={() => {
            if (savePending.current) return;
            savePending.current = true;
            setError(null);
            mutation.mutate(value.trim() || null);
          }}
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

// ── Article type badge ────────────────────────────────────────────────────────

const ARTICLE_TYPE_LABEL: Record<string, string> = {
  'thought-leadership':   'Thought Leadership',
  'product-announcement': 'Product Announcement',
  'general-update':       'General Update',
  'case-study':           'Case Study',
};

// ── Card component ────────────────────────────────────────────────────────────

interface CardProps {
  item: DiscoverItem;
  onStateChange: (id: string, state: DiscoverWorkflowState) => void;
  isUpdating: boolean;
  onActivate?: (item: DiscoverItem) => void;
  onLinkedIn: (item: DiscoverItem) => void;
  onBlog: (item: DiscoverItem) => void;
}

const DiscoverCard: React.FC<CardProps> = ({ item, onStateChange, isUpdating, onActivate, onLinkedIn, onBlog }) => {
  const isToReview  = item.workflowState === 'to-review';
  const isSaved     = item.workflowState === 'saved';
  const isBlog      = item.workflowState === 'blog';
  const isPublished = item.workflowState === 'published';
  const [copied, setCopied] = useState(false);
  const [sentToCanvas, setSentToCanvas] = useState(false);
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
    <div
      className={`dc-card${isUpdating ? ' dc-card--updating' : ''}`}
      role="article"
      aria-label={item.title}
      tabIndex={0}
      onClick={() => { onActivate?.(item); }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onActivate?.(item);
      }}
      data-ctx-title={item.title}
      data-ctx-body={item.relevanceExplanation ?? undefined}
      data-ctx-source={item.sourceTitle ?? undefined}
      data-ctx-url={item.url ?? undefined}
      data-ctx-type="hub_ref"
      data-ctx-ref-id={item.id}
      data-ctx-ref-type="discover_item"
      {...(taxonomyTags.length > 0 ? { 'data-ctx-tags': taxonomyTags.map((t) => t.colour ? `${t.name}|${t.colour}` : t.name).join(',') } : {})}
    >
      <div className="dc-card-heading">
        <div className="dc-card-heading__text">
          <div className="dc-card-meta">
            <span className="dc-card-source">{item.sourceTitle}</span>
            <span className="dc-card-dot">·</span>
            <span className="dc-card-date">{formatDate(item.publishedAt)}</span>
            {item.articleType !== null && (
              <>
                <span className="dc-card-dot">·</span>
                <span className="dc-card-type">{ARTICLE_TYPE_LABEL[item.articleType] ?? item.articleType}</span>
              </>
            )}
          </div>
          <div className="dc-card-title-row">
            <h3 className="dc-card-title">{item.title}</h3>
            {item.url !== null && (
              <a href={item.url} target="_blank" rel="noreferrer" className="dc-card-ext-link" title="Open article">
                <Launch size={16} />
              </a>
            )}
          </div>
        </div>
        {(item.spark === true || item.rankScore != null) && (
          <span
            className={`dc-score dc-score--${scoreTier(item.rankScore ?? null)}${item.spark === true ? ' dc-score--spark' : ''}`}
            title={`Weighted rank: relevance weighted by freshness, source authority, article type and project fit. The sort control chooses rank, editorial relevance or publication date. Boosts can take rank above 100.${item.spark === true ? ` ${item.sparkReason ?? 'High value content'}` : ''}`}
          >
            {item.spark === true && <span className="dc-score__spark" aria-hidden>⚡</span>}
            {item.rankScore != null && <span className="dc-score__value">{(item.rankScore * 100).toFixed(1)}<small>rank</small></span>}
          </span>
        )}
      </div>

      {/* ── Synopsis ── */}
      {item.relevanceExplanation !== null && (
        <p className="dc-card-synopsis">{item.relevanceExplanation}</p>
      )}
      {(item.alreadyCovered ?? 0) > 0 && item.coveredBy !== null && item.coveredBy !== undefined && (
        <p className="dc-card-covered" title="Athena found one of your own pieces on this">
          {item.alreadyCovered === 2 ? 'You’ve already covered this' : 'Related to something you’ve written'}: <em>{item.coveredBy}</em>
        </p>
      )}
      <ProjectFitChips fits={item.projectFit} />
      <DiscoverReview item={item} />
      {item.workflowState === 'shelved' && item.shelvedAt !== null && item.shelvedAt !== undefined && (
        <p className="dc-card-shelved">
          Shelved {formatDate(item.shelvedAt)} — {item.shelvedReason === 'low' ? 'scored low' : 'unactioned too long'}; still searchable by Athena
        </p>
      )}

      {/* Published tab: show the blog URL editor */}
      {isPublished && <PublishedUrlEditor item={item} />}

      {/* ── Footer: tags left · actions right ── */}
      <div className="dc-card-footer">
        <div className="dc-card-tags">
          {item.platform && item.platform !== 'Archive' && (
            <span className="dc-suggestion">
              Suggested:{' '}
              {item.platform === 'Full Blog Post' && 'blog post'}
              {item.platform === 'Newsletter Candidate' && 'newsletter'}
              {item.platform === 'LinkedIn Standalone' && 'LinkedIn'}
              {item.platform === 'Podcast' && 'podcast'}
            </span>
          )}
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

        <div className="dc-card-actions">
          <button type="button" className="dc-action dc-action--linkedin"
            onKeyDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); onLinkedIn(item); }}>
            <Edit size={14} /> Socials
          </button>
          <button type="button" className="dc-action dc-action--linkedin"
            onKeyDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); onBlog(item); }}>
            <Launch size={14} /> Publish to blog
          </button>
          <div className="dc-card-actions__more">
          {item.url !== null && !isPublished && (
            <button
              className={`dc-action dc-action--copy${copied ? ' dc-action--copied' : ''}`}
              onClick={handleCopyUrl}
              disabled={isUpdating}
              title="Copy URL and mark as published"
            >
              {copied ? <Checkmark size={14} /> : <Link size={14} />}
              {copied ? 'Copied' : 'Copy URL'}
            </button>
          )}
          <button
            className={`dc-action dc-action--canvas${sentToCanvas ? ' dc-action--copied' : ''}`}
            onClick={() => {
              void copyItemToCanvas({
                id: item.id,
                refType: 'discover_item',
                label: item.title ?? '',
                ...(item.relevanceExplanation ? { body: item.relevanceExplanation } : {}),
                ...(item.url ? { url: item.url } : {}),
                ...(taxonomyTags.length > 0 ? { tags: taxonomyTags.map((t) => t.name) } : {}),
              });
              setSentToCanvas(true);
              setTimeout(() => setSentToCanvas(false), 2000);
            }}
            title="Copy to canvas"
          >
            <Diagram size={14} /> {sentToCanvas ? 'Copied!' : 'Canvas'}
          </button>
          <SparkCaptureButton sourceId={item.id} sourceType="discover_item" />
          <button
            className={`dc-action dc-action--icon${connectionsOpen ? ' dc-action--connections-active' : ''}`}
            onClick={() => setConnectionsOpen((v) => !v)}
            title="Connections"
            aria-label="Connections"
          >
            <Link size={14} />
          </button>
          </div>
          {isToReview && (
              <DiscoverActions
                itemId={item.id}
                onStateChange={onStateChange}
                isUpdating={isUpdating}
              />
            )}
          {isSaved && (
            <>
              <button className="dc-action dc-action--blog" onClick={() => { onStateChange(item.id, 'blog'); }} disabled={isUpdating}>
                <Edit size={14} /> Blog
              </button>
              <button className="dc-action dc-action--archive" onClick={() => { onStateChange(item.id, 'archived'); }} disabled={isUpdating}>
                <Archive size={14} /> Archive
              </button>
              <button className="dc-action dc-action--restore" onClick={() => { onStateChange(item.id, 'to-review'); }} disabled={isUpdating}>
                <Renew size={14} /> Back
              </button>
            </>
          )}
          {isBlog && (
            <>
              <button className="dc-action dc-action--restore" onClick={() => { onStateChange(item.id, 'saved'); }} disabled={isUpdating}>
                <Renew size={14} /> Unsave
              </button>
              <button className="dc-action dc-action--archive" onClick={() => { onStateChange(item.id, 'archived'); }} disabled={isUpdating}>
                <Archive size={14} /> Archive
              </button>
            </>
          )}
          {isPublished && (
            <button className="dc-action dc-action--restore" onClick={() => { onStateChange(item.id, 'to-review'); }} disabled={isUpdating}>
              <Renew size={14} /> Unpublish
            </button>
          )}
          {(item.workflowState === 'archived' || item.workflowState === 'shelved') && (
            <button className="dc-action dc-action--restore" onClick={() => { onStateChange(item.id, 'to-review'); }} disabled={isUpdating}
              title={item.workflowState === 'shelved' ? 'Put it back in To Review for another week' : undefined}>
              <ArrowRight size={14} /> Restore
            </button>
          )}
          {item.workflowState === 'shelved' && (
            <>
              <button className="dc-action dc-action--save" onClick={() => { onStateChange(item.id, 'saved'); }} disabled={isUpdating}>
                <Bookmark size={14} /> Save
              </button>
              <button className="dc-action dc-action--archive" onClick={() => { onStateChange(item.id, 'archived'); }} disabled={isUpdating}>
                <Archive size={14} /> Archive
              </button>
            </>
          )}
        </div>
      </div>

      {connectionsOpen && <ConnectionsPanel refId={item.id} refType="discover_item" />}
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

export const DiscoverPage: React.FC = () => {
  const [restored] = useState(() => {
    try {
      const raw = localStorage.getItem(DISCOVER_PREFERENCES_KEY);
      const view = raw === null ? { ...DEFAULT_DISCOVER_VIEW } : parseWorkspaceView(JSON.parse(raw) as unknown);
      if (view.kind !== 'discover') throw new Error('Invalid Discovery preferences.');
      return { view, error: null };
    } catch (error) {
      console.warn('[Discover] Could not restore device-local filters.', error);
      return { view: { ...DEFAULT_DISCOVER_VIEW }, error };
    }
  });
  const [preferenceError, setPreferenceError] = useState<unknown>(restored.error);
  const [activeTab, setActiveTab] = useState<ActiveTab>(restored.view.tab);
  const [sourceFilter, setSourceFilter] = useState<string | undefined>(restored.view.source || undefined);
  const [cfpStateFilter, setCfpStateFilter] = useState<CfpWorkflowState>(restored.view.cfpState);
  const [sort, setSort] = useState(restored.view.sort);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const updatingIdsRef = useRef(new Set<string>());
  const [page, setPage] = useState(1);
  const [titleSearch, setTitleSearch] = useState(restored.view.title);
  const [debouncedTitleSearch, setDebouncedTitleSearch] = useState(restored.view.title);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [blogItem, setBlogItem] = useState<{ id: string; title: string } | null>(null);
  const [linkedInItem, setLinkedInItem] = useState<{ id: string; title: string } | null>(null);
  const queryClient = useQueryClient();
  const { setAthenaContext } = useAthenaContext();

  const PAGE_SIZE = 25;

  const isInbox = activeTab === 'inbox';
  const isCfps  = activeTab === 'cfps';
  const workflowState = isInbox ? 'to-review' : activeTab as DiscoverWorkflowState;

  useEffect(() => {
    try {
      const preferences: DiscoverPreferences = { version: 1, kind: 'discover', tab: activeTab,
        source: sourceFilter ?? '', title: titleSearch, sort, cfpState: cfpStateFilter };
      localStorage.setItem(DISCOVER_PREFERENCES_KEY, JSON.stringify(parseWorkspaceView(preferences)));
    } catch (error) { console.warn('[Discover] Filters could not be remembered.', error); setPreferenceError(error); }
  }, [activeTab, sourceFilter, titleSearch, sort, cfpStateFilter]);

  // Debounce the title search so we don't fire a request on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedTitleSearch(titleSearch.trim()); }, 300);
    return () => { clearTimeout(timer); };
  }, [titleSearch]);

  // Reset to page 1 when tab or source filter changes
  function handleTabChange(tab: ActiveTab): void {
    setActiveTab(tab);
    setPage(1);
  }
  function handleSourceFilter(source: string | undefined): void {
    setSourceFilter(source);
    setPage(1);
  }
  function handleTitleSearchChange(value: string): void {
    setTitleSearch(value);
    setPage(1);
  }

  const feedQuery = useQuery({
    queryKey: ['discover', workflowState, sourceFilter, page, debouncedTitleSearch, sort],
    queryFn: async () => requireApiSuccess(await api.getDiscoverFeed(workflowState, sourceFilter, page, PAGE_SIZE, debouncedTitleSearch || undefined, sort)),
    enabled: !isInbox && !isCfps,
  });

  const cfpQuery = useQuery({
    queryKey: ['cfps', cfpStateFilter],
    queryFn: async () => requireApiSuccess(await api.getCfpItems(cfpStateFilter)),
    staleTime: 60_000,
    enabled: isCfps,
  });

  const emailQuery = useQuery({
    queryKey: ['discover-emails'],
    queryFn: async () => requireApiSuccess(await api.getTimeline({ source: 'email', pageSize: 50 })),
    staleTime: 60_000,
    enabled: isInbox,
  });

  const sourcesQuery = useQuery({
    queryKey: ['discover-sources', workflowState],
    queryFn: async () => requireApiSuccess(await api.getDiscoverSources(workflowState)),
    staleTime: 60_000,
    enabled: !isInbox && !isCfps,
  });

  const workflowMutation = useMutation({
    mutationFn: async ({ id, state }: { id: string; state: DiscoverWorkflowState }) =>
      requireApiData(await api.updateDiscoverWorkflow(id, state)),
    onMutate: ({ id }) => {
      setUpdatingIds((prev) => new Set([...prev, id]));
    },
    onSettled: (_data, _err, { id }) => {
      updatingIdsRef.current.delete(id);
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['discover'] });
    },
  });

  const cfpMutation = useMutation({
    mutationFn: async ({ id, state }: { id: string; state: CfpWorkflowState }) =>
      requireApiData(await api.updateCfpState(id, state)),
    onMutate: ({ id }) => { setUpdatingIds((prev) => new Set([...prev, id])); },
    onSettled: (_data, _err, { id }) => {
      updatingIdsRef.current.delete(id);
      setUpdatingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      void queryClient.invalidateQueries({ queryKey: ['cfps'] });
    },
  });

  const handleStateChange = useCallback(
    (id: string, state: DiscoverWorkflowState) => {
      if (updatingIdsRef.current.has(id)) return;
      updatingIdsRef.current.add(id);
      workflowMutation.mutate({ id, state });
    },
    [workflowMutation],
  );

  const handleCfpStateChange = useCallback(
    (id: string, state: CfpWorkflowState) => {
      if (updatingIdsRef.current.has(id)) return;
      updatingIdsRef.current.add(id);
      cfpMutation.mutate({ id, state });
    },
    [cfpMutation],
  );

  const sources = feedQuery.data?.success ? [] : [];
  const allSources = sourcesQuery.data?.success ? sourcesQuery.data.data : [];
  void sources; // suppress unused warning — we use allSources

  const items = useMemo<DiscoverItem[]>(() =>
    feedQuery.data?.success ? feedQuery.data.data.items : [], [feedQuery.data]);
  const total: number =
    feedQuery.data?.success ? feedQuery.data.data.total : 0;

  const activeTabDef = STATE_TABS.find((t) => t.key === activeTab) ?? STATE_TABS[0];
  const activeQuery = isCfps ? cfpQuery : isInbox ? emailQuery : feedQuery;
  const changeError = isCfps ? cfpMutation.error : workflowMutation.error;

  useEffect(() => {
    const activeItem = items.find((item) => item.id === activeItemId) ?? null;
    if (activeItem === null) {
      setAthenaContext(null);
      return;
    }
    setAthenaContext({
      type: 'discover item',
      title: activeItem.title,
      detail: [
        activeItem.sourceTitle,
        activeItem.relevanceExplanation ?? '',
        activeItem.url ?? '',
      ].filter(Boolean).join(' | '),
    });
    return () => { setAthenaContext(null); };
  }, [activeItemId, items, setAthenaContext]);

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
        <button type="button" className="dc-sources-toggle" aria-expanded={sourcesOpen} onClick={() => { setSourcesOpen((o) => !o); }}>
          {sourcesOpen ? 'Hide sources' : 'Sources'}
        </button>
      </div>
      {sourcesOpen && <DiscoverSources onClose={() => { setSourcesOpen(false); }} />}
      {preferenceError != null && <DataNotice title="Discovery filters could not be remembered or restored" error={preferenceError} />}
      <SavedViews current={{ version: 1, kind: 'discover', tab: activeTab, source: sourceFilter ?? '',
        title: titleSearch, sort, cfpState: cfpStateFilter }} onApply={next => {
        if (next.kind !== 'discover') return;
        setActiveTab(next.tab); setSourceFilter(next.source || undefined); setTitleSearch(next.title);
        setDebouncedTitleSearch(next.title.trim()); setCfpStateFilter(next.cfpState); setSort(next.sort); setPage(1);
      }} />

      {/* ── Combined toolbar: state tabs + optional filters ── */}
      <div className="dc-toolbar">
        <div className="dc-tabs">
          {STATE_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`dc-tab${activeTab === tab.key ? ' dc-tab--active' : ''}`}
              aria-pressed={activeTab === tab.key}
              onClick={() => { handleTabChange(tab.key); }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeQuery.isError && <DataNotice title="Discovery feed is unavailable" error={activeQuery.error} onRetry={() => { void activeQuery.refetch(); }} />}
        {changeError !== null && <DataNotice title="Discovery change was not saved" error={changeError} />}
        {!isInbox && !isCfps && sourcesQuery.isError && <DataNotice title="Source filters are unavailable" error={sourcesQuery.error} onRetry={() => { void sourcesQuery.refetch(); }} />}

        <div className="dc-toolbar__filters">
          {!isInbox && !isCfps && <select className="dc-filter-select dc-sort-select" aria-label="Sort articles" value={sort}
            onChange={event => {
              const next = event.target.value;
              if (next === 'weighted' || next === 'editorial' || next === 'latest') { setSort(next); setPage(1); }
            }}>
            <option value="weighted">Weighted rank</option><option value="editorial">Editorial relevance</option><option value="latest">Latest</option>
          </select>}
          {/* Title search — plain text, article tabs only */}
          {!isInbox && !isCfps && (
            <div className="dc-search">
              <Search size={16} className="dc-search__icon" />
              <input
                type="text"
                className="dc-search__input"
                placeholder="Search titles…"
                value={titleSearch}
                maxLength={256}
                onChange={(e) => { handleTitleSearchChange(e.target.value); }}
                aria-label="Search articles by title"
              />
              {titleSearch !== '' && (
                <button
                  type="button"
                  className="dc-search__clear"
                  onClick={() => { handleTitleSearchChange(''); }}
                  aria-label="Clear search"
                >
                  <Close size={14} />
                </button>
              )}
            </div>
          )}

          {/* Source filter — select dropdown on article tabs */}
          {!isInbox && !isCfps && (allSources.length > 0 || sourceFilter !== undefined) && (
            <select
              className="dc-filter-select"
              value={sourceFilter ?? ''}
              onChange={(e) => { handleSourceFilter(e.target.value || undefined); }}
              aria-label="Filter by source"
            >
              <option value="">All sources ({allSources.reduce((n, s) => n + s.count, 0)})</option>
              {sourceFilter && !allSources.some(source => source.title === sourceFilter)
                && <option value={sourceFilter}>{sourceFilter} (saved scope, not currently available)</option>}
              {allSources.map((s) => (
                <option key={s.title} value={s.title}>{s.title} ({s.count})</option>
              ))}
            </select>
          )}

          {/* CFP state filter */}
          {isCfps && (
            <select
              className="dc-filter-select"
              value={cfpStateFilter}
              onChange={(e) => { setCfpStateFilter(e.target.value as CfpWorkflowState); }}
              aria-label="Filter CFPs by state"
            >
              {(['to_review', 'saved', 'submitted', 'archived'] as CfpWorkflowState[]).map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* CFPs feed */}
      {isCfps && (
        <div className="dc-feed">
          {cfpQuery.isLoading && <div className="dc-loading"><InlineLoading description="Loading CFPs…" /></div>}
          {!cfpQuery.isLoading && !cfpQuery.isError && (cfpQuery.data?.success ? cfpQuery.data.data : []).length === 0 && (
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
          {sort !== 'weighted' && <p className="dc-sort-note">Ordered by {sort === 'editorial' ? 'editorial relevance' : 'publication date'}.
            {' '}Badges still show weighted rank.</p>}
          {feedQuery.isLoading && (
            <div className="dc-loading">
              <InlineLoading description="Loading articles…" />
            </div>
          )}

          {!feedQuery.isLoading && !feedQuery.isError && items.length === 0 && (
            <div className="dc-empty">
              {debouncedTitleSearch !== ''
                ? <p>No articles matching <strong>&ldquo;{debouncedTitleSearch}&rdquo;</strong> in <strong>{activeTabDef?.label}</strong>.</p>
                : <p>No articles in <strong>{activeTabDef?.label}</strong>.</p>}
            </div>
          )}

          {items.map((item) => (
            <DiscoverCard
              key={item.id}
              item={item}
              onStateChange={handleStateChange}
              isUpdating={updatingIds.has(item.id)}
              onActivate={(nextItem) => { setActiveItemId(nextItem.id); }}
              onLinkedIn={(nextItem) => { setLinkedInItem(nextItem); }}
              onBlog={(nextItem) => { setBlogItem(nextItem); }}
            />
          ))}

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="dc-pagination">
              <button
                className="dc-pagination__btn"
                disabled={page <= 1}
                onClick={() => { setPage((p) => Math.max(1, p - 1)); }}
              >
                ← Prev
              </button>
              <span className="dc-pagination__info">
                Page {page} of {Math.ceil(total / PAGE_SIZE)}
              </span>
              <button
                className="dc-pagination__btn"
                disabled={page >= Math.ceil(total / PAGE_SIZE)}
                onClick={() => { setPage((p) => p + 1); }}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Inbox tab — emails */}
      {isInbox && (
        <div className="dc-feed">
          {emailQuery.isLoading && (
            <div className="dc-loading"><InlineLoading description="Loading emails…" /></div>
          )}
          {!emailQuery.isLoading && !emailQuery.isError && (emailQuery.data?.success ? emailQuery.data.data.items : []).length === 0 && (
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
                <button type="button" className="dc-action dc-action--linkedin"
                  onClick={() => { setLinkedInItem({ id: email.id, title: email.title }); }}>
                  <Edit size={14} /> Socials
                </button>
              </div>
            );
          })}
        </div>
      )}
      {blogItem && <BlogPublishModal key={blogItem.id} itemId={blogItem.id} title={blogItem.title}
        onClose={() => { setBlogItem(null); }} />}
      {linkedInItem && <LinkedInDraftModal key={linkedInItem.id} itemId={linkedInItem.id} title={linkedInItem.title}
        onClose={() => { setLinkedInItem(null); }} />}
    </div>
  );
};
