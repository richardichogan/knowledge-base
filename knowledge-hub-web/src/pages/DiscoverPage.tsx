/**
 * DiscoverPage — AI-curated inbound article feed + CFP speaking opportunities.
 *
 * Athena reads its feeds (managed under Sources) first, then shows a short "since you
 * last looked" briefing, a few standouts, the other relevant items, and the full ranked list. Cards
 * carry the judgement and why it was picked; production actions live in Explore.
 * Primary views: For you · Saved. Secondary: Shelved · Blog · Published · Archived · CFPs · Inbox.
 *
 * CFPs (Calls for Papers) appear in their own tab — scored, sorted by deadline.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { usePageTitle } from '../navigation/PageTitle';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Bookmark, Archive, Renew, Launch, ArrowRight, Checkmark, Microphone } from '@carbon/icons-react';
import { api } from '../services/api';
import { requireApiData, requireApiSuccess } from '../services/apiError';
import { DataNotice } from '../components/DataNotice';
import { PageHeader } from '../components/PageHeader';
import type { DiscoverItem, DiscoverWorkflowState, CfpItem, CfpWorkflowState } from '../services/api';
import { DiscoverExplore } from '../components/discover/DiscoverExplore';
import { DiscoverWatchlists } from '../components/discover/DiscoverWatchlists';
import { DiscoverInterests } from '../components/discover/DiscoverInterests';
import { buildBriefing, readSinceLastLooked } from '../features/discover/discoverInsights';
import { DiscoverSources } from '../components/discover/DiscoverSources';
import { useFlatTags } from '../hooks/useTaxonomy';
import { IdentityChip, ctxTags, identitiesFor, useIdentity } from '../identity';
import { useAthenaContext } from '../context/AthenaContext';
import { BlogPublishModal } from '../components/discover/BlogPublishModal';
import { LinkedInDraftModal } from '../components/discover/LinkedInDraftModal';
import { EmailInbox } from '../components/discover/EmailInbox';
import { DEFAULT_DISCOVER_VIEW, DISCOVER_PREFERENCES_KEY, parseWorkspaceView, type DiscoverPreferences, type DiscoverTab } from '../utils/savedViews';

// ── Config ────────────────────────────────────────────────────────────────────

type ActiveTab = DiscoverTab;

interface TabDef {
  key: ActiveTab;
  label: string;
}

const PRIMARY_TABS: TabDef[] = [
  { key: 'to-review',  label: 'For you' },
  { key: 'saved',      label: 'Saved' },
  { key: 'parking-lot', label: 'Parking lot' },
  { key: 'watchlists', label: 'Watchlists' },
];

const MORE_TABS: TabDef[] = [
  { key: 'shelved',    label: 'Shelved' },
  { key: 'blog',       label: 'Planned for blog' },
  { key: 'published',  label: 'Published' },
  { key: 'archived',   label: 'Archived' },
  { key: 'cfps',       label: 'CFPs' },
  { key: 'inbox',      label: 'Inbox' },
];

const STATE_TABS: TabDef[] = [...PRIMARY_TABS, ...MORE_TABS];

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

// ── Card component ────────────────────────────────────────────────────────────

interface CardProps {
  item: DiscoverItem;
  onStateChange: (id: string, state: DiscoverWorkflowState) => void;
  isUpdating: boolean;
  onActivate?: (item: DiscoverItem) => void;
  onExplore: (item: DiscoverItem) => void;
}

/**
 * One discovery, reduced to the decision: what it is, Athena's judgement,
 * why it was picked, and save / dismiss / explore. Production actions live
 * in the Explore panel.
 */
const DiscoverCard: React.FC<CardProps> = ({ item, onStateChange, isUpdating, onActivate, onExplore }) => {
  const state = item.workflowState;
  const isPublished = state === 'published';
  const identity = useIdentity();
  const taxonomyTags = identitiesFor(identity, item.taxonomyTagIds ?? []);
  const ctx = ctxTags(taxonomyTags);
  const stop = (e: React.SyntheticEvent): void => { e.stopPropagation(); };

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
        onExplore(item);
      }}
      data-ctx-title={item.title}
      data-ctx-body={item.relevanceExplanation ?? undefined}
      data-ctx-source={item.sourceTitle ?? undefined}
      data-ctx-url={item.url ?? undefined}
      data-ctx-type="hub_ref"
      data-ctx-ref-id={item.id}
      data-ctx-ref-type="discover_item"
      {...(ctx !== undefined ? { 'data-ctx-tags': ctx } : {})}
    >
      <div className="dc-card-meta">
        <span className="dc-card-source">{item.sourceTitle}</span>
        <span className="dc-card-dot">·</span>
        <span className="dc-card-date">{formatDate(item.publishedAt)}</span>
      </div>
      <div className="dc-card-title-row">
        <h3 className="dc-card-title">{item.title}</h3>
        {item.url !== null && (
          <a href={item.url} target="_blank" rel="noreferrer" className="dc-card-ext-link" title="Open article" onClick={stop}>
            <Launch size={16} />
          </a>
        )}
      </div>

      {item.relevanceExplanation !== null && (
        <p className="dc-card-synopsis">{item.relevanceExplanation}</p>
      )}
      {item.parking && item.description && <p className="dc-parking-excerpt">{item.description}</p>}
      {(item.alreadyCovered ?? 0) > 0 && item.coveredBy !== null && item.coveredBy !== undefined && (
        <p className="dc-card-covered" title="Athena found one of your own pieces on this">
          {item.alreadyCovered === 2 ? 'You’ve already covered this' : 'Related to something you’ve written'}: <em>{item.coveredBy}</em>
        </p>
      )}
      {state === 'shelved' && item.shelvedAt !== null && item.shelvedAt !== undefined && (
        <p className="dc-card-shelved">
          Shelved {formatDate(item.shelvedAt)} — {item.shelvedReason === 'low' ? 'scored low' : 'unactioned too long'}; still searchable by Athena
        </p>
      )}
      {isPublished && <PublishedUrlEditor item={item} />}
      <div className="dc-card-footer" onClick={stop} onKeyDown={stop}>
        {taxonomyTags.length > 0 && (
          <div className="dc-card-tags kh-chip-row">
            {taxonomyTags.map((t) => <IdentityChip key={t.tagId} identity={t} />)}
          </div>
        )}
        <div className="dc-card-actions">
          {(state === 'to-review' || state === 'shelved') && (
            <>
              <button type="button" className="dc-action dc-action--save" onClick={() => { onStateChange(item.id, 'saved'); }} disabled={isUpdating}>
                <Bookmark size={14} /> Save
              </button>
              <button type="button" className="dc-action dc-action--archive" onClick={() => { onStateChange(item.id, 'archived'); }} disabled={isUpdating}>
                <Archive size={14} /> Not interested
              </button>
            </>
          )}
          {(state === 'saved' || state === 'blog') && (
            <>
              <button type="button" className="dc-action dc-action--restore" onClick={() => { onStateChange(item.id, state === 'blog' ? 'saved' : 'to-review'); }} disabled={isUpdating}>
                <Renew size={14} /> {state === 'blog' ? 'Back to Saved' : 'Unsave'}
              </button>
              <button type="button" className="dc-action dc-action--archive" onClick={() => { onStateChange(item.id, 'archived'); }} disabled={isUpdating}>
                <Archive size={14} /> Archive
              </button>
            </>
          )}
          {(state === 'archived' || state === 'shelved') && (
            <button type="button" className="dc-action dc-action--restore" onClick={() => { onStateChange(item.id, 'to-review'); }} disabled={isUpdating}
              title={state === 'shelved' ? 'Put it back in For you for another week' : undefined}>
              <ArrowRight size={14} /> Restore
            </button>
          )}
          {isPublished && (
            <button type="button" className="dc-action dc-action--restore" onClick={() => { onStateChange(item.id, 'to-review'); }} disabled={isUpdating}>
              <Renew size={14} /> Unpublish
            </button>
          )}
          <button type="button" className="dc-action dc-action--explore" onClick={() => { onExplore(item); }}>
            Explore <ArrowRight size={14} />
          </button>
        </div>
      </div>
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
      console.warn('[Discover] Could not restore device-local view.', error);
      return { view: { ...DEFAULT_DISCOVER_VIEW }, error };
    }
  });
  const [preferenceError, setPreferenceError] = useState<unknown>(restored.error);
  const [activeTab, setActiveTab] = useState<ActiveTab>(restored.view.tab);
  usePageTitle({ view: STATE_TABS.find((tab) => tab.key === activeTab)?.label });
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const updatingIdsRef = useRef(new Set<string>());
  const [page, setPage] = useState(1);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [blogItem, setBlogItem] = useState<{ id: string; title: string } | null>(null);
  const [linkedInItem, setLinkedInItem] = useState<{ id: string; title: string } | null>(null);
  const [exploreItem, setExploreItem] = useState<DiscoverItem | null>(null);
  const [since] = useState(() => readSinceLastLooked());
  const flatTags = useFlatTags();
  const queryClient = useQueryClient();
  const { setAthenaContext } = useAthenaContext();

  const PAGE_SIZE = 25;

  const isInbox = activeTab === 'inbox';
  const isWatchlists = activeTab === 'watchlists';
  const isParking = activeTab === 'parking-lot';
  const [interestsOpen, setInterestsOpen] = useState(false);
  const isCfps  = activeTab === 'cfps';
  const workflowState = isInbox || isParking ? 'to-review' : activeTab as DiscoverWorkflowState;

  useEffect(() => {
    try {
      const preferences: DiscoverPreferences = { ...DEFAULT_DISCOVER_VIEW, tab: activeTab };
      localStorage.setItem(DISCOVER_PREFERENCES_KEY, JSON.stringify(parseWorkspaceView(preferences)));
    } catch (error) { console.warn('[Discover] View could not be remembered.', error); setPreferenceError(error); }
  }, [activeTab]);

  function handleTabChange(tab: ActiveTab): void {
    setActiveTab(tab);
    setPage(1);
  }

  const feedQuery = useQuery({
    queryKey: ['discover', isParking ? 'parking-lot' : workflowState, page],
    queryFn: async () => requireApiSuccess(await (isParking ? api.getDiscoverParkingLot(page, PAGE_SIZE)
      : api.getDiscoverFeed(workflowState, undefined, page, PAGE_SIZE, undefined, 'weighted'))),
    enabled: !isInbox && !isCfps && !isWatchlists,
  });

  const cfpQuery = useQuery({
    queryKey: ['cfps', 'to_review'],
    queryFn: async () => requireApiSuccess(await api.getCfpItems('to_review')),
    staleTime: 60_000,
    enabled: isCfps,
  });

  const emailQuery = useQuery({
    queryKey: ['discover-emails'],
    queryFn: async () => requireApiSuccess(await api.getTimeline({ source: 'email', pageSize: 50 })),
    staleTime: 60_000,
    enabled: isInbox,
  });

  const isForYou = activeTab === 'to-review';
  const briefingQuery = useQuery({
    queryKey: ['discover', 'briefing'],
    queryFn: async () => requireApiSuccess(await api.getDiscoverFeed('to-review', undefined, 1, 100, undefined, 'weighted')),
    staleTime: 60_000,
    enabled: isForYou,
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

  const briefing = useMemo(() => {
    if (!isForYou || !briefingQuery.data?.success) return null;
    return buildBriefing(briefingQuery.data.data.items, since, (id) => flatTags.find((t) => t.id === id)?.name);
  }, [isForYou, briefingQuery.data, since, flatTags]);
  const showBriefing = briefing !== null && page === 1;
  const attentionIds = useMemo(() => new Set(showBriefing ? [...briefing.standouts, ...briefing.alsoRelevant].map((i) => i.id) : []), [showBriefing, briefing]);

  const items = useMemo<DiscoverItem[]>(() =>
    feedQuery.data?.success ? feedQuery.data.data.items : [], [feedQuery.data]);
  const listedItems = useMemo(() => items.filter((i) => !attentionIds.has(i.id)), [items, attentionIds]);
  const exploreLive = exploreItem === null ? null
    : (items.find((i) => i.id === exploreItem.id) ?? [...(briefing?.standouts ?? []), ...(briefing?.alsoRelevant ?? [])].find((i) => i.id === exploreItem.id) ?? exploreItem);
  const total: number =
    feedQuery.data?.success ? feedQuery.data.data.total : 0;
  useEffect(() => {
    if (isParking && feedQuery.isSuccess && page > 1 && items.length === 0) {
      setPage(Math.max(1, Math.ceil(total / PAGE_SIZE)));
    }
  }, [isParking, feedQuery.isSuccess, page, items.length, total]);

  const activeTabDef = STATE_TABS.find((t) => t.key === activeTab) ?? STATE_TABS[0];
  const activeQuery = isCfps ? cfpQuery : isInbox ? emailQuery : feedQuery;
  const changeError = isCfps ? cfpMutation.error : workflowMutation.error;

  useEffect(() => {
    const activeItem = items.find((item) => item.id === activeItemId)
      ?? [...(briefing?.standouts ?? []), ...(briefing?.alsoRelevant ?? [])].find((item) => item.id === activeItemId) ?? null;
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
  }, [activeItemId, items, briefing, setAthenaContext]);

  const openExplore = useCallback((item: DiscoverItem) => {
    setActiveItemId(item.id);
    setExploreItem(item);
  }, []);
  const closeExplore = useCallback(() => { setExploreItem(null); }, []);
  const renderCard = (item: DiscoverItem) => (
    <DiscoverCard key={item.id} item={item} onStateChange={handleStateChange}
      isUpdating={updatingIds.has(item.id)} onActivate={(nextItem) => { setActiveItemId(nextItem.id); }}
      onExplore={openExplore} />
  );

  return (
    <div className="page-root" role="main">
      <PageHeader title="Discover" subtitle={isWatchlists ? 'Purpose-led monitoring · private, versioned comparisons' : isCfps
              ? `${(cfpQuery.data?.success ? cfpQuery.data.data : []).length} CFPs to review`
              : feedQuery.isLoading ? 'Loading…' : `${total} article${total !== 1 ? 's' : ''} · ${activeTabDef?.label ?? ''}`} actions={
        <><button type="button" className="dc-sources-toggle" onClick={() => setInterestsOpen(true)}>Interests</button>
        <button type="button" className="dc-sources-toggle" aria-expanded={sourcesOpen} onClick={() => { setSourcesOpen((o) => !o); }}>
          {sourcesOpen ? 'Hide sources' : 'Sources'}
        </button></>
      } />
      {sourcesOpen && <DiscoverSources onClose={() => { setSourcesOpen(false); }} />}
      {interestsOpen && <DiscoverInterests onClose={() => setInterestsOpen(false)} />}
      {preferenceError != null && <DataNotice title="Discovery view could not be remembered or restored" error={preferenceError} />}

      {/* ── Discovery views ── */}
      <div className="dc-toolbar">
        <div className="dc-tabs kh-command-row">
          {PRIMARY_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`dc-tab${activeTab === tab.key ? ' dc-tab--active' : ''}`}
              aria-pressed={activeTab === tab.key}
              onClick={() => { handleTabChange(tab.key); }}
            >
              {tab.label}
            </button>
          ))}
          <select
            className={`dc-tab-more${MORE_TABS.some((t) => t.key === activeTab) ? ' dc-tab-more--active' : ''}`}
            aria-label="Other Discover lists"
            value={MORE_TABS.some((t) => t.key === activeTab) ? activeTab : ''}
            onChange={(e) => { const next = MORE_TABS.find((t) => t.key === e.target.value); if (next) handleTabChange(next.key); }}
          >
            <option value="" disabled>More…</option>
            {MORE_TABS.map((tab) => <option key={tab.key} value={tab.key}>{tab.label}</option>)}
          </select>
        </div>

        {!isWatchlists && activeQuery.isError && <DataNotice title="Discovery feed is unavailable" error={activeQuery.error} onRetry={() => { void activeQuery.refetch(); }} />}
        {!isWatchlists && changeError !== null && <DataNotice title="Discovery change was not saved" error={changeError} />}
      </div>

      {/* CFPs feed */}
      {isWatchlists && <DiscoverWatchlists />}
      {isCfps && (
        <div className="dc-feed dc-feed--discover">
          {cfpQuery.isLoading && <div className="dc-loading"><InlineLoading description="Loading CFPs…" /></div>}
          {!cfpQuery.isLoading && !cfpQuery.isError && (cfpQuery.data?.success ? cfpQuery.data.data : []).length === 0 && (
            <div className="dc-empty"><p>No CFPs to review.</p></div>
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

      {showBriefing && (
        <section className="dc-briefing" aria-labelledby="dc-briefing-title">
          <div className="dc-briefing__summary">
            <h2 id="dc-briefing-title" className="dc-briefing__eyebrow">Since you last looked</h2>
            <p className="dc-briefing__headline">
              {briefing.assessed === 0
                ? 'Nothing new since your last visit.'
                : <><strong>{briefing.assessed}</strong> new item{briefing.assessed === 1 ? '' : 's'} assessed · <strong>{briefing.relevantCount}</strong> relevant to your interests · <strong>{briefing.standouts.length}</strong> stand{briefing.standouts.length === 1 ? 's' : ''} out</>}
            </p>
            <p className="dc-briefing__detail">
              {briefing.busiest.length > 0
                ? <>Most active: {briefing.busiest.map((t, i) => <React.Fragment key={t.name}>{i > 0 && ', '}<strong>{t.name}</strong> ({t.count})</React.Fragment>)}.</>
                : briefing.assessed > 0 ? 'No topic stood out.' : `${briefing.relevantCount.toString()} earlier item${briefing.relevantCount === 1 ? ' is' : 's are'} still relevant to your interests; ${briefing.standouts.length.toString()} stand${briefing.standouts.length === 1 ? 's' : ''} out.`}
              {briefing.assessed > 0 && briefing.quiet.length > 0 && <> Nothing new from {briefing.quiet.slice(0, 4).join(', ')}{briefing.quiet.length > 4 ? ` or ${(briefing.quiet.length - 4).toString()} other sources` : ''}.</>}
              {' '}Since {since.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.
            </p>
          </div>
          <h2 className="dc-section-title">{briefing.fallback ? 'Still standing out' : 'Standouts'}</h2>
          {briefing.standouts.length === 0
            ? <p className="dc-briefing__empty">Nothing currently clears the bar. Browse everything below.</p>
            : <div className="dc-feed dc-feed--discover dc-feed--attention">
              {briefing.standouts.map((item) => renderCard(item))}
            </div>}
          {briefing.alsoRelevant.length > 0 && (
            <>
              <h2 className="dc-section-title">Also relevant ({briefing.alsoRelevant.length})</h2>
              <div className="dc-feed dc-feed--discover">
                {briefing.alsoRelevant.map((item) => renderCard(item))}
              </div>
            </>
          )}
          <h2 className="dc-section-title">Everything else</h2>
        </section>
      )}

      {/* Articles feed */}
      {isParking && <p className="dc-parking-intro">Material for a future newsletter or podcast. Parking an article does not change its Saved or publishing status, or add it to automatic podcast preparation.</p>}
      {!isInbox && !isCfps && !isWatchlists && (
        <div className="dc-feed dc-feed--discover">
          {feedQuery.isLoading && (
            <div className="dc-loading">
              <InlineLoading description="Loading articles…" />
            </div>
          )}

          {!feedQuery.isLoading && !feedQuery.isError && items.length === 0 && (
            <div className="dc-empty">
              {isParking ? <p>No articles parked yet. Choose <strong>Park for later</strong> on a Discover article, then Newsletter, Podcast or both.</p>
                : <p>No articles in <strong>{activeTabDef?.label}</strong>.</p>}
            </div>
          )}

          {listedItems.map((item) => (
            <DiscoverCard
              key={item.id}
              item={item}
              onStateChange={handleStateChange}
              isUpdating={updatingIds.has(item.id)}
              onActivate={(nextItem) => { setActiveItemId(nextItem.id); }}
              onExplore={openExplore}
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
        <div className="dc-feed dc-feed--discover">
          {emailQuery.isLoading && (
            <div className="dc-loading"><InlineLoading description="Loading emails…" /></div>
          )}
          {!emailQuery.isLoading && !emailQuery.isError && (emailQuery.data?.success ? emailQuery.data.data.items : []).length === 0 && (
            <div className="dc-empty"><p>No emails indexed.</p></div>
          )}
          {(emailQuery.data?.success ? emailQuery.data.data.items : []).length > 0 && (
            <EmailInbox items={emailQuery.data?.success ? emailQuery.data.data.items : []} onSocials={setLinkedInItem} />
          )}
        </div>
      )}
      {exploreLive && (
        <DiscoverExplore
          item={exploreLive}
          tagNames={(exploreLive.taxonomyTagIds ?? []).map((id) => flatTags.find((t) => t.id === id)?.name).filter((n): n is string => n !== undefined)}
          isUpdating={updatingIds.has(exploreLive.id)}
          onClose={closeExplore}
          onStateChange={handleStateChange}
          onLinkedIn={(nextItem) => { setLinkedInItem(nextItem); }}
          onBlog={(nextItem) => { setBlogItem(nextItem); }}
        />
      )}
      {blogItem && <BlogPublishModal key={blogItem.id} itemId={blogItem.id} title={blogItem.title}
        onClose={() => { setBlogItem(null); }} />}
      {linkedInItem && <LinkedInDraftModal key={linkedInItem.id} itemId={linkedInItem.id} title={linkedInItem.title}
        onClose={() => { setLinkedInItem(null); }} />}
    </div>
  );
};
