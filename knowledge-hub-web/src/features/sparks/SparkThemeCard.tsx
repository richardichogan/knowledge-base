/**
 * features/sparks/SparkThemeCard.tsx
 * A Spark theme: a living group of related sparks. Shows its status and what it became,
 * and lets the user develop it with Athena, turn it into a note / blog post / canvas / project,
 * or curate it (rename, merge, dismiss, reopen).
 */
import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronDown, OverflowMenuHorizontal } from '@carbon/icons-react';
import { api, type SparkCluster, type SparkThemeStatus } from '../../services/api';
import { confirmDialog } from '../../services/appDialogs';
import { describeApiError, requireApiSuccess } from '../../services/apiError';
import { BlogPublishModal } from '../../components/discover/BlogPublishModal';
import { SparkItem } from './SparkItem';
import { SparkMenu } from './SparkMenu';
import { UseCaseLauncher } from '../useCases/UseCaseLauncher';
import { OUTPUT_LABELS, developPrompt, openHref, themeOutputHref } from './sparkUtils';

const PREVIEW_COUNT = 3;
const STATUS_LABELS: Record<SparkThemeStatus, string> = { active: 'Growing', developed: 'Developed', dismissed: 'Dismissed' };

type Action =
  | { kind: 'rename'; name: string }
  | { kind: 'status'; status: SparkThemeStatus }
  | { kind: 'merge'; intoId: string }
  | { kind: 'graduate'; target: 'note' | 'canvas' | 'project' | 'tasks' };

export const SparkThemeCard: React.FC<{
  theme: SparkCluster;
  themes: SparkCluster[];
  isNew: boolean;
  onDevelop: (prompt: string) => void;
  canDrop?: boolean;
  onDropSpark?: (event: React.DragEvent) => void;
}> = ({ theme, themes, isNew, onDevelop, canDrop = false, onDropSpark }) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(theme.theme);
  const [merging, setMerging] = useState(false);
  const [blogOpen, setBlogOpen] = useState(false);
  const [useCaseOpen, setUseCaseOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => { if (!canDrop) setDragOver(false); }, [canDrop]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['sparks'] });
    void queryClient.invalidateQueries({ queryKey: ['spark-clusters'] });
    void queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] });
  };
  const mutation = useMutation({
    mutationFn: async (action: Action): Promise<string | null> => {
      if (action.kind === 'rename') requireApiSuccess(await api.updateSparkCluster(theme.id, { theme: action.name }));
      else if (action.kind === 'status') requireApiSuccess(await api.updateSparkCluster(theme.id, { status: action.status }));
      else if (action.kind === 'merge') requireApiSuccess(await api.mergeSparkThemes(theme.id, action.intoId));
      else return requireApiSuccess(await api.graduateSparkTheme(theme.id, action.target)).data.output.url ?? null;
      return null;
    },
    onMutate: () => { setError(null); },
    onSuccess: (url) => {
      setRenaming(false); setMerging(false); refresh();
      if (url) openHref(url, (to) => { void navigate(to); });
    },
    onError: (e) => { setError(describeApiError(e)); },
  });
  const graduating = mutation.isPending && mutation.variables.kind === 'graduate';

  const outputHref = themeOutputHref(theme);
  const shown = expanded ? theme.sparks : theme.sparks.slice(0, PREVIEW_COUNT);
  const mergeTargets = themes.filter((t) => t.id !== theme.id && t.status !== 'dismissed');

  function saveName(): void {
    const next = name.trim();
    if (next && next !== theme.theme) mutation.mutate({ kind: 'rename', name: next });
    else { setRenaming(false); setName(theme.theme); }
  }

  return (
    <article className={`spark-theme spark-theme--${theme.status}${canDrop ? ' spark-theme--drop-ready' : ''}${canDrop && dragOver ? ' spark-theme--drag-over' : ''}`}
      aria-label={`Theme: ${theme.theme}`}
      onDragOver={event => { if (canDrop) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(true); } }}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragOver(false); }}
      onDrop={event => { setDragOver(false); if (canDrop) onDropSpark?.(event); }}>
      {canDrop && <p className="spark-theme__drop-hint">Drop here to add to {theme.theme}</p>}
      <header className="spark-theme__header">
        {renaming ? (
          <input className="spark-input spark-theme__name-input" value={name} autoFocus aria-label="Theme name"
            onChange={(e) => { setName(e.target.value); }} onBlur={saveName}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setRenaming(false); setName(theme.theme); } }} />
        ) : (
          <h3 className="spark-theme__name" title="Double-click to rename" onDoubleClick={() => { setRenaming(true); }}>{theme.theme}</h3>
        )}
        <div className="spark-theme__badges">
          {isNew && <span className="spark-badge spark-badge--new">{theme.lastGrownAt && theme.lastGrownAt !== theme.createdAt ? 'Grew' : 'New'}</span>}
          <span className={`spark-badge spark-badge--${theme.status}`}>{STATUS_LABELS[theme.status]}</span>
          <span className="spark-theme__count">{theme.sparks.length} sparks</span>
        </div>
      </header>

      {theme.status === 'developed' && theme.outputType && (
        <div className="spark-theme__output">
          <span>Became {OUTPUT_LABELS[theme.outputType].toLowerCase()}:</span>
          {outputHref !== null
            ? <button type="button" className="spark-theme__output-link" onClick={() => { openHref(outputHref, (to) => { void navigate(to); }); }}>
                {theme.outputTitle ?? 'Open'} <ArrowRight size={12} />
              </button>
            : <strong>{theme.outputTitle}</strong>}
          {theme.newSinceDeveloped > 0 && <span className="spark-badge spark-badge--new">+{theme.newSinceDeveloped} new since</span>}
        </div>
      )}

      <div className="spark-theme__sparks">
        {shown.map((s) => <SparkItem key={s.id} spark={s} themes={themes} />)}
      </div>
      {theme.sparks.length > PREVIEW_COUNT && (
        <button type="button" className="spark-theme__toggle" aria-expanded={expanded} onClick={() => { setExpanded((v) => !v); }}>
          <ChevronDown size={14} className={expanded ? 'spark-theme__chevron--open' : undefined} />
          {expanded ? 'Show fewer' : `Show all ${theme.sparks.length}`}
        </button>
      )}

      {merging && (
        <div className="spark-theme__merge">
          <label htmlFor={`merge-${theme.id}`}>Merge into</label>
          <select id={`merge-${theme.id}`} className="spark-select" defaultValue="" disabled={mutation.isPending}
            onChange={(e) => { if (e.target.value) mutation.mutate({ kind: 'merge', intoId: e.target.value }); }}>
            <option value="" disabled>Choose a theme…</option>
            {mergeTargets.map((t) => <option key={t.id} value={t.id}>{t.theme}</option>)}
          </select>
          <button type="button" className="spark-btn" onClick={() => { setMerging(false); }}>Cancel</button>
        </div>
      )}
      {error && <p className="spark-item__error" role="alert">{error}</p>}

      <footer className="spark-theme__actions">
        {theme.status !== 'dismissed' && (
          <button type="button" className="spark-btn spark-btn--primary" onClick={() => { onDevelop(developPrompt(theme)); }}>
            Develop with Athena
          </button>
        )}
        {theme.status !== 'dismissed' && (
          <SparkMenu ariaLabel="Turn theme into" align="left" buttonClassName="spark-btn"
            label={<>{graduating ? 'Creating…' : 'Turn into'} <ChevronDown size={14} /></>}
            items={[
              { label: 'Note outline', disabled: mutation.isPending, onSelect: () => { mutation.mutate({ kind: 'graduate', target: 'note' }); } },
              { label: 'Blog post…', disabled: mutation.isPending, onSelect: () => { setBlogOpen(true); } },
              { label: 'Canvas', disabled: mutation.isPending, onSelect: () => { mutation.mutate({ kind: 'graduate', target: 'canvas' }); } },
              { label: 'Use case…', disabled: theme.sparks.length === 0, onSelect: () => { setUseCaseOpen(true); } },
              { label: 'Tasks (Plan inbox)', disabled: mutation.isPending, onSelect: () => { mutation.mutate({ kind: 'graduate', target: 'tasks' }); } },
              { label: 'Project', disabled: mutation.isPending, onSelect: () => {
                void confirmDialog(`Create a new project called "${theme.theme}" from this theme?`, { title: 'Create project', confirmLabel: 'Create project' })
                  .then((ok) => { if (ok) mutation.mutate({ kind: 'graduate', target: 'project' }); });
              } },
            ]} />
        )}
        <span className="spark-theme__spacer" />
        <SparkMenu ariaLabel="Theme actions" buttonClassName="spark-icon-btn" label={<OverflowMenuHorizontal size={16} />} items={[
          { label: 'Rename', onSelect: () => { setName(theme.theme); setRenaming(true); } },
          ...(mergeTargets.length > 0 ? [{ label: 'Merge into…', onSelect: () => { setMerging(true); } }] : []),
          ...(theme.status === 'developed' ? [{ label: 'Reopen (keep growing)', onSelect: () => { mutation.mutate({ kind: 'status', status: 'active' }); } }] : []),
          theme.status === 'dismissed'
            ? { label: 'Restore', onSelect: () => { mutation.mutate({ kind: 'status', status: 'active' }); } }
            : { label: 'Dismiss', danger: true, onSelect: () => { mutation.mutate({ kind: 'status', status: 'dismissed' }); } },
        ]} />
      </footer>

      {useCaseOpen && (
        <UseCaseLauncher onClose={() => { setUseCaseOpen(false); }} launch={{
          title: theme.theme,
          sources: theme.sparks.map((s) => ({ sourceType: 'spark' as const, sourceId: s.id })),
          sourceLabel: `Spark theme “${theme.theme}” (${theme.sparks.length === 1 ? '1 spark' : `${theme.sparks.length.toString()} sparks`})`,
        }} />
      )}
      {blogOpen && (
        <BlogPublishModal title={theme.theme} onClose={() => { setBlogOpen(false); }} source={{
          key: `spark-theme:${theme.id}`,
          publish: (post) => api.publishSparkThemeBlogPost(theme.id, post),
          onSent: refresh,
        }} />
      )}
    </article>
  );
};
