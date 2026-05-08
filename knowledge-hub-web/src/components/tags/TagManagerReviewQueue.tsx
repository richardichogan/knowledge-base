/**
 * components/tags/TagManagerReviewQueue.tsx
 * Combined review queue tab — shows AI backfill suggestions from
 * pending_tag_suggestions AND legacy discover-item suggestions.
 */
import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import type { PendingSuggestion } from '../../services/api';
import { api } from '../../services/api';
import { PendingSuggestionRow } from './PendingSuggestionRow';
import { usePendingTags, useCreateTag } from '../../hooks/useTaxonomy';

export const TagManagerReviewQueue: React.FC = () => {
  const qc = useQueryClient();
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ['tag-suggestions'] }); };
  const [rejectingAll, setRejectingAll] = React.useState(false);

  const rejectAll = async (): Promise<void> => {
    if (!confirm(`Reject all pending AI suggestions? This cannot be undone.`)) return;
    setRejectingAll(true);
    try {
      await api.rejectAllTagSuggestions();
      void qc.invalidateQueries({ queryKey: ['tag-suggestions'] });
    } finally {
      setRejectingAll(false);
    }
  };

  const { data: aiSuggestions = [], isPending: aiLoading } = useQuery<PendingSuggestion[]>({
    queryKey: ['tag-suggestions'],
    queryFn: async () => {
      const res = await api.getTagSuggestions();
      return res.success ? (res.data as PendingSuggestion[]) : [];
    },
  });

  // Legacy discover-item suggestions (content_items.tags not yet in taxonomy)
  const { data: legacy = [], refetch: legacyRefetch, isPending: legacyLoading } = usePendingTags();
  const { data: parents = [] } = useQuery({ queryKey: ['taxonomy'], queryFn: () => api.getTaxonomy() });
  const createTag = useCreateTag();
  const [legacyParentId, setLegacyParentId] = React.useState('');
  const [legacyConfirm, setLegacyConfirm]   = React.useState<string | null>(null);

  const dismissLegacy = async (s: string): Promise<void> => {
    await api.dismissPendingTag(s);
    void legacyRefetch();
  };

  const acceptLegacy = async (s: string): Promise<void> => {
    await createTag.mutateAsync({ name: s, parentId: legacyParentId || null });
    await api.dismissPendingTag(s);
    setLegacyConfirm(null);
    void legacyRefetch();
  };

  const uniqueLegacy = React.useMemo(() => {
    const seen = new Set<string>();
    return (legacy as Array<{ suggestion: string; item_id: string; item_title: string }>)
      .filter((p) => { if (seen.has(p.suggestion)) return false; seen.add(p.suggestion); return true; });
  }, [legacy]);

  if (aiLoading || legacyLoading) return <InlineLoading description="Loading queue…" />;

  return (
    <div className="tag-review-queue">
      {/* AI backfill suggestions */}
      {aiSuggestions.length > 0 && (
        <section className="tag-review-queue__section">
          <div className="tag-review-queue__section-header">
            <h3 className="tag-review-queue__section-title">AI suggestions ({aiSuggestions.length})</h3>
            <button
              type="button"
              className="tag-suggestion-row__btn tag-suggestion-row__btn--reject"
              disabled={rejectingAll}
              onClick={() => { void rejectAll(); }}
            >
              {rejectingAll ? 'Rejecting…' : 'Reject all'}
            </button>
          </div>
          {aiSuggestions.map((s) => (
            <PendingSuggestionRow key={s.id} suggestion={s} onRefresh={refresh} />
          ))}
        </section>
      )}

      {/* Legacy discover suggestions */}
      {uniqueLegacy.length > 0 && (
        <section className="tag-review-queue__section">
          <h3 className="tag-review-queue__section-title">Discover suggestions ({uniqueLegacy.length})</h3>
          {uniqueLegacy.map((p) => (
            <div key={p.suggestion} className="tag-suggestion-row">
              <div className="tag-suggestion-row__header">
                <span className="tag-suggestion-row__name">{p.suggestion}</span>
              </div>
              {legacyConfirm === p.suggestion ? (
                <div className="tag-suggestion-row__confirm">
                  <select
                    className="tag-suggestion-row__select"
                    value={legacyParentId}
                    onChange={(e) => setLegacyParentId(e.target.value)}
                    aria-label="Parent tag"
                  >
                    <option value="">— No parent —</option>
                    {(parents as Array<{ id: string; name: string }>).map((par) => (
                      <option key={par.id} value={par.id}>{par.name}</option>
                    ))}
                  </select>
                  <button type="button" className="tag-suggestion-row__btn tag-suggestion-row__btn--accept"
                    onClick={() => { void acceptLegacy(p.suggestion); }}>Save</button>
                  <button type="button" className="tag-suggestion-row__btn"
                    onClick={() => setLegacyConfirm(null)}>Cancel</button>
                </div>
              ) : (
                <div className="tag-suggestion-row__actions">
                  <button type="button" className="tag-suggestion-row__btn tag-suggestion-row__btn--accept"
                    onClick={() => setLegacyConfirm(p.suggestion)}>Accept</button>
                  <button type="button" className="tag-suggestion-row__btn tag-suggestion-row__btn--reject"
                    onClick={() => { void dismissLegacy(p.suggestion); }}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {aiSuggestions.length === 0 && uniqueLegacy.length === 0 && (
        <p className="tag-panel-empty-state">No pending suggestions.</p>
      )}
    </div>
  );
};
