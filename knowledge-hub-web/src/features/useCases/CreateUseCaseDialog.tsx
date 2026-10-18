/**
 * CreateUseCaseDialog — names a new use case, optionally seeded with the item it came from
 * (a Discover item, Spark, note or canvas). When it starts from an item, the item can
 * instead be added to an open use case.
 */
import React, { useId, useState } from 'react';
import { AppDialog } from '../../components/AppDialog';
import { useProjects } from '../../hooks/useProjects';
import { useAddUseCaseSources, useCreateUseCase, useUseCases } from '../../hooks/useUseCases';
import { describeApiError } from '../../services/apiError';
import { CLOSED_STAGES, PRODUCT_KINDS, PRODUCT_KIND_LABELS, type ProductKind, type UseCaseDetail, type UseCaseSourceRef } from '../../types/useCases';

export const CreateUseCaseDialog: React.FC<{
  onClose: () => void;
  onCreated: (useCase: UseCaseDetail) => void;
  initialTitle?: string;
  initialSummary?: string;
  initialProjectId?: string | null;
  sources?: UseCaseSourceRef[];
  /** Shown under the title so it is clear what the use case starts from. */
  sourceLabel?: string;
}> = ({ onClose, onCreated, initialTitle = '', initialSummary = '', initialProjectId = null, sources = [], sourceLabel }) => {
  const id = useId();
  const [title, setTitle] = useState(initialTitle.slice(0, 200));
  const [summary, setSummary] = useState(initialSummary.slice(0, 4000));
  const [productKind, setProductKind] = useState<ProductKind>('imagine_demo');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const { data: projects = [] } = useProjects();
  const create = useCreateUseCase();
  const addSources = useAddUseCaseSources();
  const { data: existing = [] } = useUseCases();
  const open = existing.filter((u) => !CLOSED_STAGES.includes(u.stage));
  const canAdd = sources.length > 0 && open.length > 0;
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [targetId, setTargetId] = useState('');
  const adding = canAdd && mode === 'existing';
  const pending = create.isPending || addSources.isPending;
  const failure = create.error ?? addSources.error;

  const submit = (): void => {
    if (pending) return;
    if (adding) {
      if (targetId === '') return;
      addSources.mutate({ id: targetId, sources }, { onSuccess: (detail) => { onCreated(detail); } });
      return;
    }
    if (title.trim() === '') return;
    create.mutate({ title: title.trim(), summary: summary.trim(), productKind, projectId: projectId || null, sources }, {
      onSuccess: (created) => { onCreated(created); },
    });
  };

  const ready = adding ? targetId !== '' : title.trim() !== '';
  const busyLabel = adding ? 'Adding…' : 'Creating…';

  return (
    <AppDialog title={adding ? 'Add to a use case' : 'New use case'} onClose={onClose} actions={<>
      <button type="button" className="kh-btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="kh-btn-accent" disabled={!ready || pending} onClick={submit}>
        {pending ? busyLabel : adding ? 'Add to use case' : 'Create use case'}
      </button>
    </>}>
      <form className="kh-uc-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {sourceLabel !== undefined && <p className="kh-uc-form__from">From {sourceLabel}</p>}
        {canAdd && (
          <fieldset className="kh-uc-modes">
            <legend className="kh-uc-field__label">Start</legend>
            {(['new', 'existing'] as const).map((m) => (
              <label key={m} className={`kh-uc-mode${mode === m ? ' kh-uc-mode--active' : ''}`}>
                <input type="radio" name={`${id}-mode`} value={m} checked={mode === m} onChange={() => { setMode(m); }} />
                <span className="kh-uc-mode__title">{m === 'new' ? 'A new use case' : 'Add to an open use case'}</span>
              </label>
            ))}
          </fieldset>
        )}
        {adding ? (
          <label className="kh-uc-field" htmlFor={`${id}-target`}>
            <span className="kh-uc-field__label">Use case</span>
            <select id={`${id}-target`} className="kh-uc-input kh-uc-select" value={targetId}
              onChange={(e) => { setTargetId(e.target.value); }}>
              <option value="">Choose a use case…</option>
              {open.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
            </select>
          </label>
        ) : <>
        <label className="kh-uc-field" htmlFor={`${id}-title`}>
          <span className="kh-uc-field__label">Title</span>
          <input id={`${id}-title`} className="kh-uc-input" value={title} maxLength={200} data-dialog-autofocus required
            placeholder="e.g. Agent-led claims triage" onChange={(e) => { setTitle(e.target.value); }} />
        </label>
        <label className="kh-uc-field" htmlFor={`${id}-summary`}>
          <span className="kh-uc-field__label">The idea, in a sentence or two (optional)</span>
          <textarea id={`${id}-summary`} className="kh-uc-input kh-uc-input--area" rows={3} maxLength={4000} value={summary}
            onChange={(e) => { setSummary(e.target.value); }} />
        </label>
        <div className="kh-uc-form__row">
          <label className="kh-uc-field" htmlFor={`${id}-kind`}>
            <span className="kh-uc-field__label">Becomes</span>
            <select id={`${id}-kind`} className="kh-uc-input kh-uc-select" value={productKind}
              onChange={(e) => { setProductKind(e.target.value as ProductKind); }}>
              {PRODUCT_KINDS.map((k) => <option key={k} value={k}>{PRODUCT_KIND_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="kh-uc-field" htmlFor={`${id}-project`}>
            <span className="kh-uc-field__label">Project</span>
            <select id={`${id}-project`} className="kh-uc-input kh-uc-select" value={projectId}
              onChange={(e) => { setProjectId(e.target.value); }}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        </>}
        {failure !== null && <p className="kh-uc-error" role="alert">{describeApiError(failure)}</p>}
      </form>
    </AppDialog>
  );
};
