/**
 * features/sparks/SparkPanel.tsx
 * The Sparks page: an idea incubator.
 * Capture (composer) → Connect (themes that grow as related sparks arrive) → Mature (develop with Athena)
 * → Ship (turn a theme into a note, blog post, canvas or project). Loose sparks sit below the themes.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from '@carbon/icons-react';
import { api, type SparkCluster, type SparkThemeStatus } from '../../services/api';
import { SparkComposer } from './SparkComposer';
import { SparkThemeCard } from './SparkThemeCard';
import { SparkItem } from './SparkItem';
import { useLooseSparks, useSparkThemes } from './sparkQueries';
import { describeApiError, requireApiSuccess } from '../../services/apiError';

const SPARK_DRAG_TYPE = 'application/x-athena-loose-spark';

const FILTERS: Array<{ id: SparkThemeStatus; label: string }> = [
  { id: 'active', label: 'Growing' },
  { id: 'developed', label: 'Developed' },
  { id: 'dismissed', label: 'Dismissed' },
];

function matches(theme: SparkCluster, needle: string): boolean {
  if (!needle) return true;
  return theme.theme.toLowerCase().includes(needle) ||
    theme.sparks.some((s) => s.body.toLowerCase().includes(needle) || (s.sourceTitle ?? '').toLowerCase().includes(needle));
}

export const SparkPanel: React.FC<{ onDevelop: (prompt: string) => void }> = ({ onDevelop }) => {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<SparkThemeStatus>('active');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search.trim()); }, 300);
    return () => { clearTimeout(t); };
  }, [search]);

  const { themes, isLoading } = useSparkThemes();
  const { sparks: loose, isLoading: looseLoading } = useLooseSparks(debounced);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const moveInFlight = useRef(false);
  const [moveMessage, setMoveMessage] = useState('');
  const [moveError, setMoveError] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: async ({ sparkId, theme }: { sparkId: string; theme: SparkCluster }) =>
      requireApiSuccess(await api.updateSpark(sparkId, { cluster_id: theme.id })),
    onSuccess: async (_response, { theme }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sparks'] }),
        queryClient.invalidateQueries({ queryKey: ['spark-clusters'] }),
        queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] }),
      ]);
      setMoveMessage(`Spark added to ${theme.theme}.`);
    },
    onError: (error) => { setMoveMessage(''); setMoveError(`Could not move spark: ${describeApiError(error)}. It is still shown below; drag it again or use Add to theme.`); },
    onSettled: () => { moveInFlight.current = false; },
  });

  function endDrag(): void { dragId.current = null; setDraggedId(null); }
  function startDrag(event: React.DragEvent, id: string): void {
    if (moveInFlight.current || !loose.some(s => s.id === id)) { event.preventDefault(); return; }
    event.dataTransfer.setData(SPARK_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
    dragId.current = id;
    setDraggedId(id);
    setMoveMessage('');
    setMoveError(null);
  }
  function dropSpark(event: React.DragEvent, theme: SparkCluster): void {
    event.preventDefault();
    const id = dragId.current;
    if (!id || moveInFlight.current || theme.status === 'dismissed' ||
      event.dataTransfer.getData(SPARK_DRAG_TYPE) !== id || !loose.some(s => s.id === id)) return;
    moveInFlight.current = true;
    endDrag();
    setMoveMessage(`Adding spark to ${theme.theme}...`);
    move.mutate({ sparkId: id, theme });
  }

  // Themes that were new (or grew) when the page opened keep their badge for this visit; mark them seen.
  const newIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (isLoading || newIds.current !== null) return;
    const unseen = themes.filter((t) => !t.surfaced && t.status !== 'dismissed');
    newIds.current = new Set(unseen.map((t) => t.id));
    if (unseen.length === 0) return;
    void Promise.all(unseen.map((t) => api.updateSparkCluster(t.id, { surfaced: true })))
      .then(() => { void queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] }); });
  }, [themes, isLoading, queryClient]);

  const needle = debounced.toLowerCase();
  const counts = useMemo(() => {
    const c: Record<SparkThemeStatus, number> = { active: 0, developed: 0, dismissed: 0 };
    for (const t of themes) if (t.sparks.length > 0) c[t.status] += 1;
    return c;
  }, [themes]);
  const visible = themes.filter((t) => t.status === filter && t.sparks.length > 0 && matches(t, needle));

  return (
    <div className="spark-panel">
      <section className="spark-panel__section">
        <h2 className="spark-panel__heading">Capture a spark</h2>
        <SparkComposer />
      </section>

      <div className="spark-panel__search">
        <Search size={16} className="spark-panel__search-icon" />
        <input className="spark-panel__search-input" type="search" placeholder="Search sparks and themes"
          aria-label="Search sparks and themes" value={search} onChange={(e) => { setSearch(e.target.value); }} />
      </div>

      <p className="spark-panel__move-status" role="status" aria-live="polite">{moveMessage}</p>
      {moveError && <p className="spark-item__error" role="alert">{moveError}</p>}

      <section className="spark-panel__section" aria-label="Themes">
        <div className="spark-panel__section-head">
          <h2 className="spark-panel__heading">Themes</h2>
          <div className="spark-panel__filters" role="tablist" aria-label="Theme status">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id}
                className={`spark-chip${filter === f.id ? ' spark-chip--active' : ''}`}
                onClick={() => { setFilter(f.id); }}>
                {f.label}<span className="spark-chip__count">{counts[f.id]}</span>
              </button>
            ))}
          </div>
        </div>
        {isLoading ? <p className="spark-panel__empty">Loading themes…</p>
          : visible.length === 0 ? (
            <p className="spark-panel__empty">
              {needle ? 'No themes match your search.'
                : filter === 'active' ? 'No growing themes yet. When three or more related sparks come together, Athena groups them into a theme here. You can also start one from any spark with “Add to theme…”.'
                : filter === 'developed' ? 'Nothing developed yet. Turn a theme into a note, blog post, canvas or project and it moves here.'
                : 'No dismissed themes.'}
            </p>
          ) : (
            <div className="spark-panel__themes">
              {visible.map((t) => (
                <SparkThemeCard key={t.id} theme={t} themes={themes} isNew={newIds.current?.has(t.id) ?? false} onDevelop={onDevelop}
                  canDrop={draggedId !== null && !move.isPending && t.status !== 'dismissed'} onDropSpark={event => { dropSpark(event, t); }} />
              ))}
            </div>
          )}
      </section>

      <section className="spark-panel__section" aria-label="Loose sparks">
        <div className="spark-panel__section-head">
          <h2 className="spark-panel__heading">Loose sparks</h2>
          <span className="spark-panel__hint">Drag a Spark into a theme, or use Add to theme</span>
        </div>
        {looseLoading ? <p className="spark-panel__empty">Loading sparks…</p>
          : loose.length === 0 ? <p className="spark-panel__empty">{needle ? 'No loose sparks match your search.' : 'No loose sparks.'}</p>
          : <div className="spark-panel__loose">{loose.map((s) => <SparkItem key={s.id} spark={s} themes={themes}
              drag={{ disabled: move.isPending, active: draggedId === s.id, onStart: event => { startDrag(event, s.id); }, onEnd: endDrag }} />)}</div>}
      </section>
    </div>
  );
};
