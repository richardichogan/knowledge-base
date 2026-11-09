/**
 * components/today/DiscoverPicks.tsx — "Worth posting today": three unposted Discover articles
 * Athena chose each morning, with a suggested angle and one-click social drafts in Discover.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowRight, Launch } from '@carbon/icons-react';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import type { DiscoverPick, DiscoverPicksResponse } from '../../types/discoverPicks';

export const DISCOVER_PICKS_KEY = ['today', 'discover-picks'] as const;

export function useDiscoverPicks() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: DISCOVER_PICKS_KEY,
    queryFn: async (): Promise<DiscoverPicksResponse> => {
      const res = await api.getDiscoverPicks();
      if (!res.success) throw new Error(res.error.message);
      return res.data;
    },
  });
  const refresh = useMutation({
    mutationFn: async (): Promise<DiscoverPicksResponse> => {
      const res = await api.refreshDiscoverPicks();
      if (!res.success) throw new Error(res.error.message);
      return res.data;
    },
    onSuccess: (data) => { qc.setQueryData(DISCOVER_PICKS_KEY, data); },
  });
  return { query, refresh, picks: query.data?.picks?.picks ?? [], saved: query.data?.picks ?? null };
}

export function chosenLabel(generatedAt: string): string {
  return new Date(generatedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function draftHref(pick: DiscoverPick, format: 'linkedin' | 'short'): string {
  const params = new URLSearchParams({ socialDraft: pick.id, format, title: pick.title });
  return `/discover?${params.toString()}`;
}

export function picksContext(picks: DiscoverPick[], generatedAt: string | null): string {
  if (!generatedAt) return 'Worth posting today: no picks have been chosen yet.';
  if (picks.length === 0) return `Worth posting today (chosen ${generatedAt}): no remaining picks.`;
  return `Worth posting today (chosen ${generatedAt}; read_discover_picks returns the live list; set_discover_item_state with archived removes a pick):\n${picks.map((p, i) =>
    `${i + 1}. [${p.id}] ${p.title} — ${p.source || 'unknown source'}, ${p.workflowState}. Angle: ${p.angle}`).join('\n')}`;
}

export function DiscoverPickDetail({ pick, onAsk }: { pick: DiscoverPick; onAsk: () => void }): React.ReactElement {
  const qc = useQueryClient();
  const archive = useMutation({
    mutationFn: async () => {
      const res = await api.updateDiscoverWorkflow(pick.id, 'archived');
      if (!res.success) throw new Error(res.error.message);
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: DISCOVER_PICKS_KEY }),
        qc.invalidateQueries({ queryKey: ['discover'] }),
      ]);
    },
  });
  return (
    <article className="today-brief__item">
      <div className="today-brief__item-top">
        <span className="today-brief__meta">{[pick.source, pick.workflowState === 'saved' ? 'Saved' : 'To review'].filter(Boolean).join(' · ')}</span>
      </div>
      <h3>{pick.title}</h3>
      <p className="today-brief__reason"><strong>Suggested angle:</strong> {pick.angle}</p>
      {pick.publishedAt && <p className="today-brief__meta">Published {new Date(pick.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>}
      <div className="today-brief__actions">
        <Link className="today-brief__primary" to={draftHref(pick, 'linkedin')}>Draft for LinkedIn <ArrowRight size={16} /></Link>
        <Link className="today-brief__primary" to={draftHref(pick, 'short')}>Draft for Bluesky <ArrowRight size={16} /></Link>
        {pick.url && <a className="today-brief__quiet" href={pick.url} target="_blank" rel="noreferrer">Read article <Launch size={16} /></a>}
        <button type="button" className="today-brief__quiet" aria-label={`Ask Athena about ${pick.title}`} onClick={onAsk}>Ask Athena</button>
                <button type="button" className="today-brief__quiet" disabled={archive.isPending} onClick={() => { archive.mutate(); }}>
                  <Archive size={16} /> {archive.isPending ? 'Archiving...' : 'Archive'}
                </button>
              </div>
              {archive.isError && <p className="today-brief__error" role="alert">The article could not be archived. {describeApiError(archive.error)}</p>}
            </article>
  );
}

export function refreshError(error: unknown): string {
  return `Athena could not choose new picks. ${describeApiError(error)}`;
}
