import React, { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Renew } from '@carbon/icons-react';
import { api } from '../services/api';
import { useTodayBrief, requireTodayData } from '../services/useTodayBrief';
import { TODAY_LIMITS, relativeTime, todayContext, type TodayItem } from '../services/todayViewModel';
import { useAthenaContext } from '../context/AthenaContext';
import { PodcastPrepCard, usePodcastPrep } from '../components/today/PodcastPrepCard';
import { ReviewWorkspace, ReviewItem } from '../components/ReviewWorkspace';
import { PageHeader } from '../components/PageHeader';
import { useUseCases } from '../hooks/useUseCases';
import { stalledNudge } from '../features/useCases/useCaseView';
import { UpcomingMeetings } from '../components/today/UpcomingMeetings';
import { TaskDetail } from '../features/plan/TaskDetail';

type SectionQueries = Array<{ name: string; query: {
  isPending: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown>;
} }>;

function SectionState({ queries, empty, hasItems }: {
  queries: SectionQueries; empty: string; hasItems: boolean;
}): React.ReactElement {
  const loading = queries.some(({ query }) => query.isPending);
  const failures = queries.filter(({ query }) => query.isError);
  return (
    <>
      {loading && <div className="today-brief__loading" role="status" aria-label="Loading section">
        <span /><span /><span /><span className="today-brief__sr">Loading this section...</span>
      </div>}
      {failures.map(({ name, query }, index) => <div key={`${name}:${index}`} className="today-brief__error" role="alert">
        <span>{name} could not be loaded. {query.error instanceof Error ? query.error.message : ''}</span>
        <button type="button" onClick={() => { void query.refetch(); }}>Retry {name}</button>
      </div>)}
      {!loading && !hasItems && <p className="today-brief__empty">
        {failures.length > 0 ? 'No items found in the available sources. Retry the missing sources for a complete picture.' : empty}
      </p>}
    </>
  );
}

function ItemLink({ item, children }: { item: TodayItem; children: React.ReactNode }): React.ReactElement {
  return item.href.startsWith('/')
    ? <Link className="today-brief__primary" to={item.href}>{children}</Link>
    : <a className="today-brief__primary" href={item.href} target="_blank" rel="noreferrer">{children}</a>;
}

function WorkItem({ item, ask, compact = false }: {
  item: TodayItem; ask: (item: TodayItem) => void; compact?: boolean;
}): React.ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const draftUrl = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (item.clusterId) {
        if (draftUrl.current === null) {
          const { output } = requireTodayData(await api.graduateSparkTheme(item.clusterId, 'note'));
          draftUrl.current = output.url ?? `/think?noteId=${encodeURIComponent(output.ref)}`;
          void qc.invalidateQueries({ queryKey: ['notes-list'] });
          void qc.invalidateQueries({ queryKey: ['spark-clusters'] });
        }
        navigate(draftUrl.current);
      } else throw new Error('This action is not available for this item');
    },
    onMutate: () => { setError(''); },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['today'] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: ['discover'] }),
        qc.invalidateQueries({ queryKey: ['spark-clusters'] }),
        qc.invalidateQueries({ queryKey: ['notes-list'] }),
      ]);
    },
    onError: (e) => { setError(`${e instanceof Error ? e.message : 'The action could not be saved. Please try again.'}`); },
  });
  return (
    <article className={`today-brief__item${compact ? ' today-brief__item--compact' : ''}`} aria-busy={mutation.isPending}>
      <div className="today-brief__item-top">
        <span className="today-brief__meta">{[item.project, item.type].filter(Boolean).join(' · ')}</span>
        {item.status && <span className={`today-brief__status today-brief__status--${item.tone}`}>{item.status}</span>}
      </div>
      <h3>{item.title}</h3>
      <p className="today-brief__reason">{item.reason}</p>
      <p className="today-brief__meta">{item.source}{item.date ? ` · ${item.date.length === 10
        ? `Due ${new Date(`${item.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`
        : relativeTime(item.date)}` : ''}</p>
      <div className="today-brief__actions">
        {item.clusterId
          ? <button type="button" className="today-brief__primary" disabled={mutation.isPending} onClick={() => { mutation.mutate(); }}>{mutation.isPending ? 'Creating...' : 'Create outline note'}</button>
          : <ItemLink item={item}>{item.action} <ArrowRight size={16} /></ItemLink>}
        <button type="button" className="today-brief__quiet" aria-label={`Ask Athena about ${item.title}`} onClick={() => { ask(item); }}>Ask Athena</button>
      </div>
      {mutation.isPending && <p className="today-brief__meta" role="status">Saving your change...</p>}
      {error && <p className="today-brief__error" role="alert">{error}</p>}
    </article>
  );
}

export const HomePage: React.FC = () => {
  const brief = useTodayBrief();
  const { data: useCases = [] } = useUseCases();
  const useCaseNudge = stalledNudge(useCases, brief.now.getTime());
  const { model, sectionQueries } = brief;
  const { openAthena } = useAthenaContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedChanges, setExpandedChanges] = useState(false);
  const podcast = usePodcastPrep();
  const context = todayContext(model);
  function ask(prompt: string, item?: TodayItem): void {
    if (item && item.id !== 'today-all-attention') setSelectedId(item.id);
    openAthena(prompt, item ? {
      type: item.type.toLowerCase(), title: item.title, id: item.id,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      detail: `Today item:\n${JSON.stringify(item)}\n\nDaily brief:\n${context}`,
    } : { type: 'today', title: 'Today', detail: context });
  }
  const visibleAttention = model.attention.slice(0, TODAY_LIMITS.attention);
  const visibleChanges = expandedChanges ? model.changes : model.changes.slice(0, TODAY_LIMITS.changes);
  const workItems = [...visibleAttention, ...visibleChanges, ...model.continuing, ...model.exploration];
  const selection = selectedId === 'today-meetings' || selectedId === 'today-podcast' ? selectedId
    : workItems.find(item => item.id === selectedId)?.id ?? workItems[0]?.id ?? 'today-podcast';
  const selected = workItems.find(item => item.id === selection);
  const selectedSection = selected && (visibleAttention.includes(selected) ? 'Needs your attention'
    : visibleChanges.includes(selected) ? 'What changed' : model.continuing.includes(selected) ? 'Continue working' : 'Worth exploring');
  const selectedContext = selected ? {
    type: selected.type.toLowerCase(), title: selected.title, id: selected.discoverId ?? selected.taskId ?? selected.id,
    ...(selected.projectId ? { projectId: selected.projectId } : {}),
    detail: `Today section: ${selectedSection}. Selected item summary and state (retrieve the underlying record for its full content):\n${JSON.stringify(selected)}\n\nDaily brief:\n${context}`,
  } : selection === 'today-podcast' ? { type: 'podcast preparation', title: 'Podcast preparation',
    detail: `Current saved podcast preparation and job state:\n${JSON.stringify(podcast.data ?? null)}\n${podcast.isError ? 'Podcast preparation failed to load.' : ''}\n\nDaily brief:\n${context}` }
    : { type: 'today', title: 'Meeting preparation', detail: `Meeting preparation selected. Calendar records will be provided when retrieved.\n\nDaily brief:\n${context}` };
  const renderItem = (item: TodayItem): React.ReactElement => <ReviewItem key={item.id} title={item.title}
    selected={selection === item.id} meta={[item.project, item.type, item.status, item.date ? relativeTime(item.date) : item.source].filter(Boolean).join(' · ')}
    description={item.reason} onSelect={() => { setSelectedId(item.id); }} />;
  const attentionLoading = sectionQueries.attention.some(({ query }) => query.isPending);
  const partial = sectionQueries.attention.some(({ query }) => query.isError);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(brief.now));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <main className="page-root today-brief kh-review-page">
      <PageHeader title="Today" className="today-brief__header" subtitle={<>{greeting}, Richard. {attentionLoading ? 'Checking what needs your attention...'
            : visibleAttention.length > 0 ? `${visibleAttention.length} ${visibleAttention.length === 1 ? 'thing needs' : 'things need'} your attention${partial ? ' in the available sources' : ''}.`
              : partial ? 'Some sources are unavailable. Review the notices below.' : 'Nothing urgent in the available recent sources. Make space for your next piece of work.'}</>} actions={
        <button type="button" className="today-brief__quiet" disabled={brief.refreshing} onClick={() => { void brief.refresh(); }}>
          <Renew size={16} /> {brief.refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      } />
      <div className="today-brief__briefing-meta">
        <span>Changes since {new Date(brief.since).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      {brief.storageError && <p className="today-brief__error" role="status">Your browser cannot save the Today visit time. Changes use the last 24 hours.</p>}
      {brief.projects.isError && <p className="today-brief__error" role="alert">Project names are unavailable. <button type="button" onClick={() => { void brief.projects.refetch(); }}>Retry projects</button></p>}
      <ReviewWorkspace storageKey="today" label="Today" context={selectedContext}
        detail={selected ? <><h2 className="kh-review-detail-heading">{selectedSection}</h2>
          {selected.taskId ? <TaskDetail key={selected.taskId} taskId={selected.taskId} />
            : <WorkItem key={selected.id} item={selected} ask={item => { ask('Help me work out the next step for this item.', item); }} />}</>
          : selection === 'today-meetings' ? <UpcomingMeetings projects={brief.projects.data ?? []} />
            : <PodcastPrepCard />}
        list={<>
        <section className="today-brief__attention" aria-labelledby="today-attention">
          <div className="today-brief__section-heading"><h2 id="today-attention">Needs your attention</h2><Link to="/plan">All tasks in Plan</Link></div>
          <SectionState queries={sectionQueries.attention} hasItems={visibleAttention.length > 0} empty="No deadlines, blockers, or open decisions need attention in the available recent sources." />
          {visibleAttention.map(renderItem)}
          {model.attention.length > TODAY_LIMITS.attention && <p className="today-brief__meta">
            {model.attention.length - TODAY_LIMITS.attention} other attention items. <button type="button" className="today-brief__quiet" onClick={() => { ask('Review all my attention items.', {
              id: 'today-all-attention', title: 'All attention items', type: 'Today',
              reason: JSON.stringify(model.attention), tone: 'normal', href: '/plan', action: 'Review', score: 0, source: 'Today',
            }); }}>Review with Athena</button>
          </p>}
        </section>
        <section className="today-brief__changes" aria-labelledby="today-changes">
          <div className="today-brief__section-heading"><h2 id="today-changes">What changed</h2><Link to="/my-work">Full activity</Link></div>
          <SectionState queries={sectionQueries.changes} hasItems={model.changes.length > 0} empty="No changes found in the available sources during this period." />
          {visibleChanges.map(renderItem)}
          {model.changes.length > TODAY_LIMITS.changes && <button type="button" className="today-brief__quiet"
            aria-expanded={expandedChanges} onClick={() => { setExpandedChanges((v) => !v); }}>{expandedChanges ? 'Show less' : `Show ${model.changes.length - TODAY_LIMITS.changes} more summaries`}</button>}
        </section>
        <section className="today-brief__continue" aria-labelledby="today-continue">
          <div className="today-brief__section-heading"><h2 id="today-continue">Continue working</h2><Link to="/think">Go to Think</Link></div>
          {useCaseNudge !== null && <p className="today-brief__nudge"><Link to="/plan?view=use-cases">{useCaseNudge} <ArrowRight size={14} /></Link></p>}
          <SectionState queries={sectionQueries.continuing} hasItems={model.continuing.length > 0} empty="No recent drafts or active work found. Start a note in Think or choose a task in Plan." />
          {model.continuing.map(renderItem)}
        </section>
        <section className="today-brief__explore" aria-labelledby="today-explore">
          <div className="today-brief__section-heading"><h2 id="today-explore">Worth exploring</h2><Link to="/discover">Go to Discover</Link></div>
          <SectionState queries={sectionQueries.exploration} hasItems={model.exploration.length > 0} empty="No strong suggestions yet. Review Discover or ask Athena to save an idea as a Spark." />
          {model.exploration.map(renderItem)}
        </section>
        <h2>Preparation</h2>
        <ReviewItem title="Meeting preparation" meta="Indexed calendar · next seven days" description="Choose a meeting and its project context."
          selected={selection === 'today-meetings'} onSelect={() => { setSelectedId('today-meetings'); }} />
        <ReviewItem title="Podcast preparation" meta={podcast.data?.nextRecording ? `Next recording · ${podcast.data.nextRecording}` : 'Recording schedule'}
          description={podcast.isPending ? 'Checking your recording schedule…' : podcast.isError ? 'Preparation unavailable — select to retry.'
            : podcast.data?.run?.status === 'running' ? 'Research and preparation are running.' : 'Review the saved brief and preparation status.'}
          selected={selection === 'today-podcast'} onSelect={() => { setSelectedId('today-podcast'); }} />
      </>} />
    </main>
  );
};
