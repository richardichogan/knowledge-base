/**
 * UseCasesView — Plan's "Use cases" view: ideas on their way to a spec and a build,
 * grouped by what they become, with a side panel for the selected one.
 */
import React, { useEffect, useId, useState } from 'react';
import { Add } from '@carbon/icons-react';
import { SideTabsPanel } from '../../components/SideTabsPanel';
import type { PaneWidthOptions } from '../../hooks/usePersistedState';
import { useUseCases } from '../../hooks/useUseCases';
import { describeApiError } from '../../services/apiError';
import { PRODUCT_KINDS, PRODUCT_KIND_LABELS, STAGE_LABELS, USE_CASE_STAGES } from '../../types/useCases';
import { CreateUseCaseDialog } from './CreateUseCaseDialog';
import { UseCaseDetailPanel } from './UseCaseDetailPanel';
import { filterUseCases, groupByProduct, isStalled, sinceLabel, type KindFilter, type StageFilter } from './useCaseView';

const SIDE_WIDTH: PaneWidthOptions = { compact: 380, wide: 460, min: 300, max: (viewport) => Math.round(viewport * 0.5) };

export const UseCasesView: React.FC<{ filterProject: string; selectId?: string | null }> = ({ filterProject, selectId = null }) => {
  const fid = useId();
  const { data: useCases = [], isLoading, error } = useUseCases();
  const [stage, setStage] = useState<StageFilter>('active');
  const [kind, setKind] = useState<KindFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [openSeq, setOpenSeq] = useState(0);
  const [creating, setCreating] = useState(false);

  const select = (id: string): void => { setSelected(id); setOpenSeq((n) => n + 1); };
  useEffect(() => { if (selectId !== null) { setStage('all'); select(selectId); } }, [selectId]);
  const visible = filterUseCases(useCases, { stage, kind, project: filterProject });
  const groups = groupByProduct(visible);
  const filtered = stage !== 'active' || kind !== 'all' || filterProject !== '';

  return (
    <div className="kh-uc-layout">
      <div className="kh-uc-main">
        <div className="kh-uc-toolbar">
          <label className="kh-uc-visually-hidden" htmlFor={`${fid}-stage`}>Filter by stage</label>
          <select id={`${fid}-stage`} className="kh-uc-input kh-uc-select kh-uc-select--compact" value={stage}
            onChange={(e) => { setStage(e.target.value as StageFilter); }}>
            <option value="active">Open use cases</option>
            <option value="all">All stages</option>
            {USE_CASE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
          <label className="kh-uc-visually-hidden" htmlFor={`${fid}-kind`}>Filter by what it becomes</label>
          <select id={`${fid}-kind`} className="kh-uc-input kh-uc-select kh-uc-select--compact" value={kind}
            onChange={(e) => { setKind(e.target.value as KindFilter); }}>
            <option value="all">All products</option>
            {PRODUCT_KINDS.map((k) => <option key={k} value={k}>{PRODUCT_KIND_LABELS[k]}</option>)}
          </select>
          <span className="kh-uc-toolbar__count" aria-live="polite">{visible.length} of {useCases.length}</span>
          <button type="button" className="kh-btn-accent kh-uc-toolbar__new" onClick={() => { setCreating(true); }}>
            <Add size={16} /> New use case
          </button>
        </div>

        {error !== null && <p className="kh-uc-error" role="alert">Could not load use cases: {describeApiError(error)}</p>}
        {isLoading && <p className="kh-uc-panel__status">Loading use cases…</p>}

        {!isLoading && error === null && groups.length === 0 && (
          <div className="kh-uc-empty">
            {useCases.length === 0 ? <>
              <h2 className="kh-uc-empty__title">Turn an idea into something you can build</h2>
              <p className="kh-uc-empty__body">
                A use case gathers what you have found (Discover items, Sparks, notes and diagrams) into a spec,
                then hands it to GitHub Copilot or Athena Build. Start one here, or with “→ Use case” wherever the idea lives.
              </p>
              <button type="button" className="kh-btn-accent" onClick={() => { setCreating(true); }}><Add size={16} /> New use case</button>
            </> : <>
              <h2 className="kh-uc-empty__title">Nothing matches these filters</h2>
              {filtered && <button type="button" className="kh-btn-ghost" onClick={() => { setStage('active'); setKind('all'); }}>Show all open use cases</button>}
            </>}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.kind} className="kh-uc-group" aria-labelledby={`${fid}-${g.kind}`}>
            <h2 id={`${fid}-${g.kind}`} className="kh-uc-group__title">{PRODUCT_KIND_LABELS[g.kind]} <span className="kh-uc-count">{g.items.length}</span></h2>
            <ul className="kh-uc-cards">
              {g.items.map((u) => (
                <li key={u.id}>
                  <button type="button" className={`kh-uc-card${selected === u.id ? ' kh-uc-card--active' : ''}`}
                    aria-current={selected === u.id ? 'true' : undefined} onClick={() => { select(u.id); }}>
                    <span className="kh-uc-card__title">{u.title}</span>
                    {u.summary !== '' && <span className="kh-uc-card__summary">{u.summary}</span>}
                    <span className="kh-uc-card__meta">
                      <span className={`kh-uc-stage kh-uc-stage--${u.stage}`}>{STAGE_LABELS[u.stage]}</span>
                      <span>{u.sourceCount === 1 ? '1 source' : `${u.sourceCount.toString()} sources`}</span>
                      {u.projectName !== null && <span className="kh-uc-card__project">{u.projectName}</span>}
                      <span className={isStalled(u) ? 'kh-uc-card__age kh-uc-card__age--stalled' : 'kh-uc-card__age'}
                        title={isStalled(u) ? 'No progress for two weeks' : undefined}>
                        {sinceLabel(u.updatedAt) === 'today' ? 'today' : `${sinceLabel(u.updatedAt)} ago`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {selected !== null && (
        <SideTabsPanel storageKey="use-case-side" label="Use case details" defaultTab="details" width={SIDE_WIDTH}
          selectTab={{ id: 'details', seq: openSeq }}
          tabs={[{ id: 'details', label: 'Use case', content: <UseCaseDetailPanel id={selected} onClosed={() => { setSelected(null); }} /> }]} />
      )}

      {creating && <CreateUseCaseDialog initialProjectId={filterProject || null} onClose={() => { setCreating(false); }}
        onCreated={(created) => { setCreating(false); select(created.id); }} />}
    </div>
  );
};
