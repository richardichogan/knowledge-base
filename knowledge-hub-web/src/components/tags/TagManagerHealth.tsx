/**
 * components/tags/TagManagerHealth.tsx
 * Health tab — renders the latest weekly taxonomy drift report and provides
 * Delete (underused tags) and Suggest Split (overused tags) quick actions.
 */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading, InlineNotification } from '@carbon/react';
import { api } from '../../services/api';

export const TagManagerHealth: React.FC = () => {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({
    queryKey: ['taxonomy-health'],
    queryFn:  () => api.getHealthReport(),
    staleTime: 5 * 60 * 1000,
  });

  const report = data?.success ? data.data : null;
  const [splitResults, setSplitResults] = useState<Record<string, string[]>>({});
  const [busyId, setBusyId]             = useState<string | null>(null);
  const [retagStatus, setRetagStatus]   = useState<string | null>(null);

  const handleDelete = async (tagId: string): Promise<void> => {
    if (!confirm('Delete this tag? This cannot be undone.')) return;
    setBusyId(tagId);
    try {
      await api.deleteTag(tagId);
      void qc.invalidateQueries({ queryKey: ['taxonomy'] });
      void qc.invalidateQueries({ queryKey: ['taxonomy-health'] });
    } catch { /* user will see no change — safe to ignore */ }
    finally { setBusyId(null); }
  };

  const handleSuggestSplit = async (tagId: string): Promise<void> => {
    setBusyId(tagId);
    try {
      const res = await api.suggestTagSplit(tagId);
      if (res.success) {
        setSplitResults((prev) => ({ ...prev, [tagId]: res.data.suggestions }));
      }
    } catch { /* silently fail */ }
    finally { setBusyId(null); }
  };

  if (isPending) return <InlineLoading description="Loading health report…" />;

  return (
    <div className="tag-health">
      {(isError || !report) ? (
        <InlineNotification kind="warning" title="No health report available yet."
          subtitle="It is generated weekly. Run npm run taxonomy:health manually to generate one now."
          lowContrast hideCloseButton />
      ) : (
        <>
          <p className="tag-health__generated">Generated: {report.generatedAt ?? 'unknown'}</p>
          <pre className="tag-health__report">{report.content}</pre>
          <p className="tag-health__note">Use Delete on underused tags and Suggest Split on overused tags listed above.</p>
          {Object.entries(splitResults).map(([id, suggestions]) => (
            <div key={id} className="tag-health__split-result">
              <strong>Split suggestions:</strong>
              <ul>{suggestions.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          ))}
        </>
      )}
      <div className="tag-health__actions">
        <button
          type="button"
          className="tag-health__action-btn"
          disabled={busyId !== null}
          onClick={() => { void qc.invalidateQueries({ queryKey: ['taxonomy-health'] }); }}
        >
          ↻ Refresh report
        </button>
        <button
          type="button"
          className="tag-health__action-btn tag-health__action-btn--primary"
          disabled={busyId !== null || retagStatus === 'running'}
          onClick={() => {
            setRetagStatus('running');
            void api.triggerRetag(true).then((res) => {
              if (res.success) {
                setRetagStatus(`Queued ${res.data.queued} items — running in background`);
              } else {
                setRetagStatus('Failed to start backfill');
              }
            });
          }}
        >
          ⟳ Backfill all tags
        </button>
        {retagStatus !== null && (
          <p className="tag-health__retag-status">{retagStatus}</p>
        )}
      </div>
    </div>
  );
};
