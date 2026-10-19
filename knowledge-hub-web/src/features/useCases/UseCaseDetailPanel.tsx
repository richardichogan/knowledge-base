/**
 * UseCaseDetailPanel — the side-panel body for one use case: edit it, see where it came
 * from, draft its spec, hand it off, track PRs and close it.
 */
import React, { useEffect, useId, useState } from 'react';
import { Close, DocumentAdd, Launch, Send, TrashCan } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { useProjects } from '../../hooks/useProjects';
import {
  useAddUseCaseLink, useDeleteUseCase, useDraftUseCaseSpec, useRemoveUseCaseLink, useRemoveUseCaseSource, useUpdateUseCase, useUseCase,
} from '../../hooks/useUseCases';
import { describeApiError } from '../../services/apiError';
import { ProjectOptions } from '../../components/ProjectOptions';
import { confirmDialog } from '../../services/appDialogs';
import {
  PRODUCT_KINDS, PRODUCT_KIND_LABELS, SOURCE_TYPE_LABELS, STAGE_LABELS, USE_CASE_STAGES,
  type ProductKind, type UseCaseDetail, type UseCasePatch, type UseCaseStage,
} from '../../types/useCases';
import { HandoffDialog } from './HandoffDialog';
import { sinceLabel, sourceHref } from './useCaseView';

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** A text field that saves on blur (or Enter for single-line) when the value changed. */
const BlurField: React.FC<{
  id: string; label: string; value: string; onSave: (v: string) => void; multiline?: boolean; placeholder?: string;
  validate?: (v: string) => string | null; className?: string; maxLength: number;
}> = ({ id, label, value, onSave, multiline = false, placeholder, validate, className = '', maxLength }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const error = validate?.(draft.trim()) ?? null;
  const commit = (): void => { if (draft.trim() !== value && error === null) onSave(draft.trim()); };
  const common = {
    id, value: draft, placeholder, maxLength, 'aria-invalid': error !== null,
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(e.target.value); },
  };
  return (
    <label className="kh-uc-field" htmlFor={id}>
      <span className="kh-uc-field__label">{label}</span>
      {multiline
        ? <textarea {...common} rows={4} className={`kh-uc-input kh-uc-input--area ${className}`} />
        : <input {...common} className={`kh-uc-input ${className}`}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setDraft(value); }} />}
      {error !== null && draft.trim() !== value && <span className="kh-uc-error">{error}</span>}
    </label>
  );
};

export const UseCaseDetailPanel: React.FC<{ id: string; onClosed: () => void }> = ({ id, onClosed }) => {
  const { data: useCase, isLoading, error } = useUseCase(id);
  if (isLoading) return <p className="kh-uc-panel__status">Loading…</p>;
  if (useCase === undefined) return <p className="kh-uc-error" role="alert">{error !== null ? describeApiError(error) : 'Use case not found.'}</p>;
  return <Detail key={useCase.id} useCase={useCase} onClosed={onClosed} />;
};

const Detail: React.FC<{ useCase: UseCaseDetail; onClosed: () => void }> = ({ useCase, onClosed }) => {
  const fid = useId();
  const { data: projects = [] } = useProjects();
  const update = useUpdateUseCase();
  const draft = useDraftUseCaseSpec();
  const removeSource = useRemoveUseCaseSource();
  const addLink = useAddUseCaseLink();
  const removeLink = useRemoveUseCaseLink();
  const del = useDeleteUseCase();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const patch = (p: UseCasePatch): void => { update.mutate({ id: useCase.id, patch: p }); };
  const redraft = async (): Promise<void> => {
    const ok = await confirmDialog('Athena will rewrite the spec from the current sources. The current text is kept in the note\'s history, so you can restore it from Think.',
      { title: 'Redraft the spec?', confirmLabel: 'Redraft' });
    if (ok) draft.mutate({ id: useCase.id, replace: true });
  };
  const remove = async (): Promise<void> => {
    const ok = await confirmDialog(`Delete "${useCase.title}"? Its sources and spec note are not deleted.`, { title: 'Delete use case?', confirmLabel: 'Delete', tone: 'danger' });
    if (ok) del.mutate(useCase.id, { onSuccess: onClosed });
  };
  const submitLink = (): void => {
    const url = linkUrl.trim();
    if (url === '') return;
    addLink.mutate({ id: useCase.id, url }, { onSuccess: () => { setLinkUrl(''); } });
  };
  const failure = [update, draft, removeSource, addLink, removeLink, del].find((m) => m.isError)?.error;

  return (
    <div className="kh-uc-panel">
      <div className="kh-uc-panel__head">
        <span className={`kh-uc-stage kh-uc-stage--${useCase.stage}`}>{STAGE_LABELS[useCase.stage]}</span>
        <span className="kh-uc-panel__meta">Updated {sinceLabel(useCase.updatedAt)}{sinceLabel(useCase.updatedAt) === 'today' ? '' : ' ago'}</span>
      </div>

      <BlurField id={`${fid}-title`} label="Title" value={useCase.title} maxLength={200} className="kh-uc-input--title"
        validate={(v) => (v === '' ? 'A title is required.' : null)} onSave={(title) => { patch({ title }); }} />
      <BlurField id={`${fid}-summary`} label="Summary" value={useCase.summary} maxLength={4000} multiline
        placeholder="What is the idea, and who is it for?" onSave={(summary) => { patch({ summary }); }} />

      <div className="kh-uc-panel__grid">
        <label className="kh-uc-field" htmlFor={`${fid}-stage`}>
          <span className="kh-uc-field__label">Stage</span>
          <select id={`${fid}-stage`} className="kh-uc-input kh-uc-select" value={useCase.stage}
            onChange={(e) => { patch({ stage: e.target.value as UseCaseStage }); }}>
            {USE_CASE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="kh-uc-field" htmlFor={`${fid}-kind`}>
          <span className="kh-uc-field__label">Becomes</span>
          <select id={`${fid}-kind`} className="kh-uc-input kh-uc-select" value={useCase.productKind}
            onChange={(e) => { patch({ productKind: e.target.value as ProductKind }); }}>
            {PRODUCT_KINDS.map((k) => <option key={k} value={k}>{PRODUCT_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="kh-uc-field" htmlFor={`${fid}-project`}>
          <span className="kh-uc-field__label">Project</span>
          <select id={`${fid}-project`} className="kh-uc-input kh-uc-select" value={useCase.projectId ?? ''}
            onChange={(e) => { patch({ projectId: e.target.value || null }); }}>
            <option value="">No project</option>
            {useCase.projectId !== null && !projects.some((p) => p.id === useCase.projectId)
              && <option value={useCase.projectId}>{useCase.projectName ?? 'Unavailable project'}</option>}
            <ProjectOptions projects={projects} selected={useCase.projectId ?? ''} />
          </select>
        </label>
        <BlurField id={`${fid}-repo`} label="Repository" value={useCase.repo ?? ''} maxLength={200} placeholder="owner/name"
          validate={(v) => (v === '' || REPO_RE.test(v) ? null : 'Use owner/name.')} onSave={(repo) => { patch({ repo: repo || null }); }} />
      </div>

      <section className="kh-uc-section" aria-labelledby={`${fid}-spec`}>
        <h3 id={`${fid}-spec`} className="kh-uc-section__title">Spec</h3>
        {useCase.specNoteId === null ? (
          <>
            <p className="kh-uc-hint">Athena drafts a {useCase.productKind === 'product' ? 'product spec' : 'demo brief'} from the sources below, as a Think note you can edit.</p>
            <button type="button" className="kh-btn-accent" disabled={draft.isPending} onClick={() => { draft.mutate({ id: useCase.id, replace: false }); }}>
              <DocumentAdd size={16} /> {draft.isPending ? 'Drafting… (about a minute)' : 'Draft spec'}
            </button>
          </>
        ) : (
          <div className="kh-uc-row">
            <Link className="kh-btn-accent" to={`/think?noteId=${encodeURIComponent(useCase.specNoteId)}`}>Open spec in Think</Link>
            <button type="button" className="kh-btn-ghost" disabled={draft.isPending} onClick={() => { void redraft(); }}>
              {draft.isPending ? 'Redrafting…' : 'Redraft'}
            </button>
            <button type="button" className="kh-btn-ghost" onClick={() => { setHandoffOpen(true); }}>
              <Send size={16} /> Hand off…
            </button>
          </div>
        )}
        {(useCase.handoffUrl !== null || useCase.buildSpecId !== null) && (
          <ul className="kh-uc-list kh-uc-list--plain">
            {useCase.handoffUrl !== null && <li className="kh-uc-list__item">
              <span className="kh-uc-tag">GitHub</span>
              <a className="kh-uc-link" href={useCase.handoffUrl} target="_blank" rel="noreferrer">{useCase.handoffPath ?? 'Spec file'} <Launch size={14} /></a>
            </li>}
            {useCase.buildSpecId !== null && <li className="kh-uc-list__item">
              <span className="kh-uc-tag">Build</span>
              <Link className="kh-uc-link" to="/build">Athena Build spec</Link>
            </li>}
          </ul>
        )}
      </section>

      <section className="kh-uc-section" aria-labelledby={`${fid}-sources`}>
        <h3 id={`${fid}-sources`} className="kh-uc-section__title">Sources <span className="kh-uc-count">{useCase.sources.length}</span></h3>
        {useCase.sources.length === 0
          ? <p className="kh-uc-hint">No sources yet. Use “→ Use case” on a Discover item, Spark, note or canvas to add one.</p>
          : <ul className="kh-uc-list">
            {useCase.sources.map((s) => {
              const link = sourceHref(s);
              return (
                <li key={`${s.sourceType}:${s.sourceId}`} className="kh-uc-list__item">
                  <span className="kh-uc-tag">{SOURCE_TYPE_LABELS[s.sourceType]}</span>
                  {link === null ? <span className="kh-uc-list__text" title={s.title}>{s.title}</span>
                    : link.external ? <a className="kh-uc-link kh-uc-list__text" href={link.href} target="_blank" rel="noreferrer" title={s.title}>{s.title}</a>
                      : <Link className="kh-uc-link kh-uc-list__text" to={link.href} title={s.title}>{s.title}</Link>}
                  <button type="button" className="kh-uc-icon-btn" aria-label={`Remove source ${s.title}`}
                    onClick={() => { removeSource.mutate({ id: useCase.id, ref: { sourceType: s.sourceType, sourceId: s.sourceId } }); }}>
                    <Close size={16} />
                  </button>
                </li>
              );
            })}
          </ul>}
      </section>

      <section className="kh-uc-section" aria-labelledby={`${fid}-links`}>
        <h3 id={`${fid}-links`} className="kh-uc-section__title">Pull requests and links <span className="kh-uc-count">{useCase.links.length}</span></h3>
        {useCase.links.length > 0 && <ul className="kh-uc-list">
          {useCase.links.map((l) => (
            <li key={l.id} className="kh-uc-list__item">
              <a className="kh-uc-link kh-uc-list__text" href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.title}</a>
              <button type="button" className="kh-uc-icon-btn" aria-label={`Remove link ${l.title}`}
                onClick={() => { removeLink.mutate({ id: useCase.id, linkId: l.id }); }}>
                <Close size={16} />
              </button>
            </li>
          ))}
        </ul>}
        <form className="kh-uc-row kh-uc-row--nowrap" onSubmit={(e) => { e.preventDefault(); submitLink(); }}>
          <label htmlFor={`${fid}-link`} className="kh-uc-visually-hidden">Link URL</label>
          <input id={`${fid}-link`} className="kh-uc-input" type="url" value={linkUrl} placeholder="https://github.com/owner/repo/pull/1"
            onChange={(e) => { setLinkUrl(e.target.value); }} />
          <button type="submit" className="kh-btn-ghost" disabled={linkUrl.trim() === '' || addLink.isPending}>Add</button>
        </form>
      </section>

      {failure != null && <p className="kh-uc-error" role="alert">{describeApiError(failure)}</p>}

      <div className="kh-uc-panel__footer">
        {useCase.stage !== 'shipped' && <button type="button" className="kh-btn-accent" onClick={() => { patch({ stage: 'shipped' }); }}>Mark shipped</button>}
        {useCase.stage !== 'dropped' && <button type="button" className="kh-btn-ghost" onClick={() => { patch({ stage: 'dropped' }); }}>Drop</button>}
        {(useCase.stage === 'shipped' || useCase.stage === 'dropped') && (
          <button type="button" className="kh-btn-ghost" onClick={() => { patch({ stage: useCase.specNoteId === null ? 'candidate' : 'refining' }); }}>Reopen</button>
        )}
        <button type="button" className="kh-uc-icon-btn kh-uc-icon-btn--danger" aria-label="Delete use case" title="Delete use case"
          onClick={() => { void remove(); }}>
          <TrashCan size={16} />
        </button>
      </div>

      {handoffOpen && <HandoffDialog useCase={useCase} onClose={() => { setHandoffOpen(false); }} />}
    </div>
  );
};
