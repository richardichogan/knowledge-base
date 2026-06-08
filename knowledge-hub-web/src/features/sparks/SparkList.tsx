/**
 * features/sparks/SparkList.tsx
 * Reverse-chronological list of all sparks with filter chips and pagination.
 */
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TrashCan } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { Spark } from '../../services/api';

type Filter = 'all' | 'attached' | 'standalone';
const PAGE_SIZE = 20;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Single spark row with delete action. */
const SparkRow: React.FC<{ spark: Spark; onDelete: (id: string) => void }> = ({ spark, onDelete }) => (
  <div
    className="spark-row"
    data-ctx-title={spark.body.length > 80 ? spark.body.slice(0, 80) + '…' : spark.body}
    data-ctx-body={spark.body}
    data-ctx-type="hub_ref"
    data-ctx-ref-id={spark.id}
    data-ctx-ref-type="spark"
    {...(spark.sourceType ? { 'data-ctx-source': `Spark · ${spark.sourceType}` } : { 'data-ctx-source': 'Spark' })}
  >
    <p className="spark-row__body">{spark.body}</p>
    <div className="spark-row__meta">
      <span className="spark-row__date">{formatDate(spark.createdAt)}</span>
      {spark.sourceId != null && (
        <span className="spark-row__source">Attached · {spark.sourceType}</span>
      )}
    </div>
    <button
      className="spark-row__delete"
      onClick={() => { onDelete(spark.id); }}
      title="Delete spark"
    >
      <TrashCan size={14} />
    </button>
  </div>
);

/** Full paginated spark list with Attached / Standalone / All filter. */
export const SparkList: React.FC = () => {
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  const params = {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    ...(filter === 'attached' && { attached: true }),
    ...(filter === 'standalone' && { attached: false }),
  };

  const { data, isLoading } = useQuery({
    queryKey: ['sparks', filter, page],
    queryFn: () => api.listSparks(params),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSpark(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['sparks'] }); },
  });

  const sparks: Spark[] = data?.success ? data.data : [];

  const filters: Filter[] = ['all', 'attached', 'standalone'];

  return (
    <div className="spark-list">
      <div className="spark-list__filters">
        {filters.map((f) => (
          <button
            key={f}
            className={`spark-list__chip${filter === f ? ' spark-list__chip--active' : ''}`}
            onClick={() => { setFilter(f); setPage(1); }}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {isLoading && <p className="spark-list__empty">Loading…</p>}

      {!isLoading && sparks.length === 0 && (
        <p className="spark-list__empty">No sparks yet.</p>
      )}

      {sparks.map((s) => (
        <SparkRow key={s.id} spark={s} onDelete={(id) => { deleteMutation.mutate(id); }} />
      ))}

      {sparks.length === PAGE_SIZE && (
        <button
          className="spark-list__load-more"
          onClick={() => { setPage((p) => p + 1); }}
        >
          Load more
        </button>
      )}
    </div>
  );
};
