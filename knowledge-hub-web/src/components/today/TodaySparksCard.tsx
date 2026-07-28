/**
 * components/today/TodaySparksCard.tsx
 * Inline spark capture + surfaced cluster list + recent sparks.
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { Spark, SparkCluster } from '../../services/api';

interface TodaySparksCardProps {
  /** Cluster IDs already shown in the ranked list — these are excluded here. */
  rankedClusterIds?: string[];
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Inline capture + clusters + recent sparks in one card. */
export const TodaySparksCard: React.FC<TodaySparksCardProps> = ({ rankedClusterIds = [] }) => {
  const [captureText, setCaptureText] = useState('');
  const [captureOk, setCaptureOk] = useState(false);
  const queryClient = useQueryClient();

  const clustersQuery = useQuery({
    queryKey: ['spark-clusters', { dismissed: false }],
    queryFn: () => api.listSparkClusters({ dismissed: false }),
  });

  const sparksQuery = useQuery({
    queryKey: ['today-sparks-recent'],
    queryFn: () => api.listSparks({ limit: 3 }),
  });

  const captureMutation = useMutation({
    mutationFn: (body: string) => api.createSpark({ body, tags: [] }),
    onSuccess: () => {
      setCaptureText('');
      setCaptureOk(true);
      setTimeout(() => setCaptureOk(false), 2000);
      void queryClient.invalidateQueries({ queryKey: ['today-sparks-recent'] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => api.updateSparkCluster(id, { dismissed: true }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] }); },
  });

  const draftMutation = useMutation({
    mutationFn: (id: string) => api.updateSparkCluster(id, { surfaced: true }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] }); },
  });

  const allClusters: SparkCluster[] =
    clustersQuery.data?.success === true ? (clustersQuery.data.data as SparkCluster[]) : [];

  const clusters = allClusters.filter(
    (c) => c.sparkCount >= 4 && !rankedClusterIds.includes(c.id),
  );

  const sparks: Spark[] =
    sparksQuery.data?.success === true ? (sparksQuery.data.data as Spark[]) : [];

  function handleCapture(): void {
    const body = captureText.trim();
    if (body) captureMutation.mutate(body);
  }

  return (
    <div className="today-section-card">
      <div className="today-section-card__header">
        <span className="today-section-card__title">Sparks</span>
      </div>

      {/* Inline capture */}
      <div className="today-spark-capture">
        <input
          type="text"
          placeholder="Capture a thought…"
          value={captureText}
          onChange={(e) => { setCaptureText(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCapture(); }}
          className="today-spark-capture__input"
        />
        <button
          className="dc-action dc-action--save"
          onClick={handleCapture}
          disabled={captureMutation.isPending || captureText.trim() === ''}
        >
          {captureOk ? '✓ Captured' : 'Capture'}
        </button>
      </div>

      {/* Surfaced clusters */}
      <div style={{ padding: '4px 16px 8px', borderBottom: '1px solid var(--cds-border-subtle-01)' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--cds-text-secondary)', textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.08em' }}>
          Clusters
        </div>
        {clusters.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--cds-text-secondary)', margin: '0 0 8px' }}>
            No clusters yet — sparks accumulate into clusters over time.
          </p>
        ) : clusters.map((c) => (
          <div key={c.id} className="today-ranked-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <div className="today-ranked-row__body">
              <div className="today-ranked-row__title">{c.theme}</div>
              <div className="today-ranked-row__context">{c.sparkCount} sparks</div>
            </div>
            <div className="today-ranked-row__actions">
              <button className="dc-action dc-action--save" onClick={() => { draftMutation.mutate(c.id); }} disabled={draftMutation.isPending}>Draft outline</button>
              <button className="dc-action dc-action--archive" onClick={() => { dismissMutation.mutate(c.id); }} disabled={dismissMutation.isPending}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>

      {/* Recent sparks */}
      <div style={{ padding: '8px 16px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--cds-text-secondary)', textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.08em' }}>
          Recent sparks
        </div>
        {sparks.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--cds-text-secondary)', margin: 0 }}>
            No sparks yet — capture your first one above.
          </p>
        ) : sparks.map((s) => (
          <div key={s.id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: 'var(--cds-text-primary)' }}>
              {s.body.length > 100 ? `${s.body.slice(0, 100)}…` : s.body}
            </div>
            <div style={{ fontSize: 11, color: 'var(--cds-text-secondary)', marginTop: 2 }}>
              {timeAgo(s.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
