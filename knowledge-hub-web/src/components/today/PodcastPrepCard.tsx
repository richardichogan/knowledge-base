import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { requireTodayData } from '../../services/useTodayBrief';
import { podcastBriefUrl, type PodcastPrepRun } from '../../types/podcastPrep';
import { episodeUrl } from '../../types/podcastEpisodes';

export function usePodcastPrep() {
  return useQuery({
    queryKey: ['podcast-prep'],
    queryFn: async () => requireTodayData(await api.getPodcastPrep()),
    refetchInterval: 30_000, staleTime: 15_000,
  });
}

/** The episode's Prep tab when the brief created one; otherwise the brief chat. */
function useBriefHref(run: PodcastPrepRun | null | undefined): string | null {
  const episode = useQuery({
    queryKey: ['podcast-episode-for-recording', run?.recordingDate],
    queryFn: async () => requireTodayData(await api.podcastEpisodeForRecording(run!.recordingDate)),
    enabled: !!run?.generatedAt, retry: false, staleTime: 60_000,
  });
  if (!run?.generatedAt) return null;
  return episode.data?.noteId ? episodeUrl(episode.data.noteId, 'prep') : podcastBriefUrl(run);
}

export const PodcastPrepCard: React.FC = () => {
  const qc = useQueryClient();
  const query = usePodcastPrep();
  const generate = useMutation({
    mutationFn: async () => requireTodayData(await api.generatePodcastPrep()),
    onSuccess: (data) => { qc.setQueryData(['podcast-prep'], data); },
  });
  const { data } = query;
  const run = data?.run;
  const brief = run?.generatedAt ? run : data?.latestBrief;
  const running = run?.status === 'running';
  const briefHref = useBriefHref(brief);
  return (
    <section className="podcast-prep" aria-labelledby="podcast-prep-title" aria-busy={running || generate.isPending}>
      <div className="podcast-prep__heading"><h2 id="podcast-prep-title">Podcast preparation</h2>
        <span>Thursday · 07:00 UK</span></div>
      {query.isPending && <p role="status">Checking your recording schedule...</p>}
      {query.isError && <p className="podcast-prep__error" role="alert">Could not load podcast preparation.
        <button type="button" onClick={() => { void query.refetch(); }}>Retry</button></p>}
      {data && <>
        <p>{data.nextRecording ? `Next recording: ${data.nextRecording}` : 'No recording date set.'}</p>
        {data.scheduleWarning && <p className="podcast-prep__warning">{data.scheduleWarning}</p>}
        {running ? <p role="status">Researching fresh topics and checking prior episodes. Your brief will appear here when ready.</p>
          : run?.status === 'failed' ? <p className="podcast-prep__error" role="alert">{run.error ?? 'Preparation failed.'}</p>
            : run?.status === 'ready' ? <p>{run.warnings.length ? 'Brief ready, with research limitations noted.' : 'Your shortlist and three recommended discussions are ready.'}</p>
              : <p>Prepared automatically before a scheduled Friday recording. You can also prepare it now.</p>}
        <div className="podcast-prep__actions">
          {brief?.generatedAt && briefHref && <a href={briefHref} target="_blank" rel="noreferrer">Open {brief.recordingDate === data.nextRecording ? 'podcast brief' : `last brief (${brief.recordingDate})`}</a>}
          <button type="button" disabled={running || generate.isPending || Boolean(data.scheduleWarning)}
            onClick={() => { generate.mutate(); }}>
            {running || generate.isPending ? 'Preparing...' : run?.generatedAt ? 'Refresh brief' : run?.status === 'failed' ? 'Retry preparation' : 'Prepare now'}
          </button>
        </div>
      </>}
      {generate.isError && <p className="podcast-prep__error" role="alert">{generate.error instanceof Error ? generate.error.message : 'Could not start preparation.'}</p>}
    </section>
  );
};

export const PodcastPrepNotification: React.FC = () => {
  const qc = useQueryClient();
  const { data } = usePodcastPrep();
  const run = data?.run?.status === 'ready' ? data.run : data?.latestBrief;
  const briefHref = useBriefHref(run);
  const acknowledge = useMutation({
    mutationFn: async () => {
      if (!run?.generatedAt) throw new Error('No completed podcast brief to acknowledge');
      return requireTodayData(await api.acknowledgePodcastPrep(run.recordingDate, run.generatedAt));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['podcast-prep'] }); },
  });
  if (run?.status !== 'ready' || !run.generatedAt || run.acknowledgedAt) return null;
  return (
    <div className="podcast-prep-notification" role="region" aria-label="Podcast brief ready">
      <span><strong>Podcast brief ready</strong> — recording {run.recordingDate}.
        {run.warnings.length > 0 ? ' Check the research limitations.' : ''}</span>
      <div className="podcast-prep__actions">
        <a href={briefHref ?? podcastBriefUrl(run)} target="_blank" rel="noreferrer">Open podcast brief</a>
        <button type="button" disabled={acknowledge.isPending} onClick={() => { acknowledge.mutate(); }}>Dismiss</button>
      </div>
      {acknowledge.isError && <p className="podcast-prep__error" role="alert">Could not dismiss this notification. Please retry.</p>}
    </div>
  );
};
