import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Project } from '../../services/api';
import { requireApiData, describeApiError } from '../../services/apiError';
import { MeetingPreparation } from '../MeetingPreparation';
import { useAthenaContext } from '../../context/AthenaContext';

export const UpcomingMeetings: React.FC<{ projects: readonly Project[] }> = ({ projects }) => {
  const { setAthenaContext } = useAthenaContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range] = useState(() => { const now = new Date(); return {
    rangeStart: now.toISOString(), rangeEnd: new Date(now.getTime() + 7 * 86400000).toISOString(),
  }; });
  const meetings = useQuery({ queryKey: ['upcoming-meetings', range],
    queryFn: async () => requireApiData(await api.getTimeline({ source: 'graph-calendar', ...range, pageSize: 25, order: 'asc' })),
    staleTime: 60_000 });
  const items = (meetings.data?.items ?? []).filter(item => item.metadata?.isCancelled !== true).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const selected = items.find(item => item.id === selectedId);
  const selectedMeetingId = selected?.id;
  const selectedTitle = selected?.title;
  const contextDetail = JSON.stringify({ items, selected, total: meetings.data?.total, unavailable: meetings.isError, loading: meetings.isPending });
  useEffect(() => {
    setAthenaContext({ type: selectedMeetingId ? 'calendar event' : 'today meetings', title: selectedTitle ?? 'Upcoming meetings',
      ...(selectedMeetingId ? { id: selectedMeetingId } : {}),
      detail: `Indexed calendar entries currently in view:\n${contextDetail}\nThese are saved summaries and metadata, not necessarily full invitations. Retrieve meeting preparation before claiming to have read the full invitation.` });
  }, [contextDetail, selectedMeetingId, selectedTitle, setAthenaContext]);
  return <section className="today-brief__meetings kh-work-context" aria-label="Upcoming meetings">
    <h2>Meeting preparation</h2>
    <p>Upcoming indexed calendar entries in the next seven days. Choose a meeting, then its project; no automatic AI calls.</p>
    {meetings.isPending && <p role="status">Reading calendar entries...</p>}
    {meetings.isError && <p role="alert">{describeApiError(meetings.error)} <button type="button" className="kh-btn-ghost" onClick={() => { void meetings.refetch(); }}>Retry calendar</button></p>}
    {!meetings.isPending && !meetings.isError && !items.length && <p>No upcoming entries found in the indexed calendar. This does not confirm that the calendar connection is current.</p>}
    {items.map(item => <details className="kh-work-context__note" key={item.id}
      onToggle={event => { if (event.currentTarget.open) setSelectedId(item.id); }}>
      <summary>{item.title} · {new Date(item.publishedAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</summary>
      <MeetingPreparation eventId={item.id} projects={projects}
        broadcastContext={selectedId === item.id}
        initialProjectId={projects.some(project => project.id === item.projectContext) ? item.projectContext : undefined} />
    </details>)}
    {(meetings.data?.total ?? 0) > 25 && <p className="kh-work-context__warning">Showing up to 25 indexed entries. Open Activity for other calendar records.</p>}
  </section>;
};
