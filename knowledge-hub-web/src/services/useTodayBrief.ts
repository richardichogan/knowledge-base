import { useEffect, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { fetchNotes } from '../notes/noteStorage';
import { buildTodayModel, readTodayTasks, type TodayChatDetails } from './todayViewModel';
import type { ApiResponse } from '../types/apiResponse';

export function requireTodayData<T>(response: ApiResponse<T>): T {
  if (!response.success) throw new Error(response.error.message);
  return response.data;
}

export const TODAY_VISIT_KEY = 'kh-today-last-visit';

export function useTodayBrief() {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => new Date());
  const [visit] = useState(() => {
    try {
      const previous = localStorage.getItem(TODAY_VISIT_KEY);
      if (previous && Number.isFinite(Date.parse(previous)) && Date.parse(previous) <= Date.now()) {
        return { since: previous, storageError: false };
      }
    } catch {
      return { since: new Date(Date.now() - 86_400_000).toISOString(), storageError: true };
    }
    return { since: new Date(Date.now() - 86_400_000).toISOString(), storageError: false };
  });
  const { since } = visit;
  const [storageError, setStorageError] = useState(visit.storageError);
  useEffect(() => {
    try { localStorage.setItem(TODAY_VISIT_KEY, now.toISOString()); }
    catch { setStorageError(true); }
  }, [now]);
  const tasks = useQuery({
    queryKey: ['today', 'tasks'],
    queryFn: async () => readTodayTasks(requireTodayData(await api.getTasks())),
  });
  const notes = useQuery({ queryKey: ['today', 'notes'], queryFn: fetchNotes });
  const projects = useQuery({ queryKey: ['today', 'projects'], queryFn: async () => requireTodayData(await api.getProjects()) });
  const activity = useQuery({
    queryKey: ['today', 'activity'],
    queryFn: async () => requireTodayData(await api.getTimeline({ pageSize: 100 })).items,
  });
  const sources = useQuery({ queryKey: ['today', 'sources'], queryFn: async () => requireTodayData(await api.getSources()) });
  const discover = useQuery({
    queryKey: ['today', 'discover'],
    queryFn: async () => requireTodayData(await api.getDiscoverFeed('to-review', undefined, 1, 30)).items,
  });
  const clusters = useQuery({
    queryKey: ['today', 'clusters'],
    queryFn: async () => requireTodayData(await api.listSparkClusters({ dismissed: false })),
  });
  const canvases = useQuery({ queryKey: ['today', 'canvases'], queryFn: async () => requireTodayData(await api.listCanvases()) });
  const sessions = useQuery({
    queryKey: ['today', 'sessions'],
    queryFn: async () => requireTodayData(await api.listChatSessions()).sessions
      .filter((s) => !s.title.startsWith('Morning briefing'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4),
  });
  const outputQueries = useQueries({
    queries: (sessions.data ?? []).map((session) => ({
      queryKey: ['today', 'outputs', session.id],
      queryFn: async () => requireTodayData(await api.listChatOutputs(session.id)),
    })),
  });
  const decisionQueries = useQueries({
    queries: (sessions.data ?? []).map((session) => ({
      queryKey: ['today', 'decisions', session.id],
      queryFn: async () => requireTodayData(await api.getChatDecisions(session.id)).decisions,
    })),
  });
  const chats: TodayChatDetails[] = (sessions.data ?? []).map((session, index) => ({
    session, outputs: outputQueries[index]?.data ?? [], decisions: decisionQueries[index]?.data ?? [],
  }));
  const chatQueries = [
    ...outputQueries.map((query) => ({ name: 'Athena outputs', query })),
    ...decisionQueries.map((query) => ({ name: 'Athena decisions', query })),
  ];
  const briefing = useQuery({
    queryKey: ['morning-briefing'],
    queryFn: async () => requireTodayData(await api.getMorningBriefing()),
    staleTime: 300_000,
  });
  const model = buildTodayModel({
    tasks: tasks.data ?? [], notes: notes.data ?? [], projects: projects.data ?? [],
    activity: activity.data ?? [], sources: sources.data ?? [], discover: discover.data ?? [],
    clusters: clusters.data ?? [], canvases: canvases.data ?? [],
    chats,
  }, now, since);
  const sectionQueries = {
    attention: [{ name: 'Plan', query: tasks }, { name: 'Connections', query: sources }, { name: 'Activity', query: activity },
      { name: 'Athena sessions', query: sessions }, ...decisionQueries.map((query) => ({ name: 'Athena decisions', query }))],
    continuing: [{ name: 'Think notes', query: notes }, { name: 'Canvases', query: canvases }, { name: 'Plan', query: tasks },
      { name: 'Athena sessions', query: sessions }, ...chatQueries],
    changes: [{ name: 'Activity', query: activity }, { name: 'Athena sessions', query: sessions },
      ...outputQueries.map((query) => ({ name: 'Athena outputs', query }))],
    exploration: [{ name: 'Discover', query: discover }, { name: 'Sparks', query: clusters }],
  };
  async function refresh(): Promise<void> {
    setNow(new Date());
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['today'] }),
      queryClient.invalidateQueries({ queryKey: ['morning-briefing'] }),
    ]);
  }
  return { model, now, since, storageError, briefing, projects, sectionQueries, refresh,
    refreshing: Object.values(sectionQueries).flat().some(({ query }) => query.isFetching) || briefing.isFetching };
}
