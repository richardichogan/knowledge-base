/**
 * CreateUseCaseDialog — names a new use case, optionally seeded with the item it came from
 * (a Discover item, Spark, note or canvas).
 */
import React, { useId, useState } from 'react';
import { AppDialog } from '../../components/AppDialog';
import { useProjects } from '../../hooks/useProjects';
import { useCreateUseCase } from '../../hooks/useUseCases';
import { describeApiError } from '../../services/apiError';
import { PRODUCT_KINDS, PRODUCT_KIND_LABELS, type ProductKind, type UseCaseDetail, type UseCaseSourceRef } from '../../types/useCases';

export const CreateUseCaseDialog: React.FC<{
  onClose: () => void;
  onCreated: (useCase: UseCaseDetail) => void;
  initialTitle?: string;
  initialProjectId?: string | null;
  sources?: UseCaseSourceRef[];
  /** Shown under the title so it is clear what the use case starts from. */
  sourceLabel?: string;
}> = ({ onClose, onCreated, initialTitle = '', initialProjectId = null, sources = [], sourceLabel }) => {
  const id = useId();
  const [title, setTitle] = useState(initialTitle.slice(0, 200));
  const [summary, setSummary] = useState('');
  const [productKind, setProductKind] = useState<ProductKind>('imagine_demo');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const { data: projects = [] } = useProjects();
  const create = useCreateUseCase();

  const submit = (): void => {
    if (title.trim() === '' || create.isPending) return;
    create.mutate({ title: title.trim(), summary: summary.trim(), productKind, projectId: projectId || null, sources }, {
      onSuccess: (created) => { onCreated(created); },
    });
  };

  return (
    <AppDialog title="New use case" onClose={onClose} actions={<>
      <button type="button" className="kh-btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="kh-btn-accent" disabled={title.trim() === '' || create.isPending} onClick={submit}>
        {create.isPending ? 'Creating…' : 'Create use case'}
      </button>
    </>}>
      <form className="kh-uc-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {sourceLabel !== undefined && <p className="kh-uc-form__from">From {sourceLabel}</p>}
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
        {create.isError && <p className="kh-uc-error" role="alert">{describeApiError(create.error)}</p>}
      </form>
    </AppDialog>
  );
};
