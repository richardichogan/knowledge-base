/**
 * components/ProjectsModal.tsx
 * Slide-over panel for managing repo → taxonomy tag mappings.
 *
 * Each mapping says: "commits/PRs/releases from these GitHub repos or
 * GitLab paths belong to this tag". No separate project concept —
 * the taxonomy tag IS the project label.
 */

import React, { useEffect, useState } from 'react';
import { Button, InlineLoading, InlineNotification } from '@carbon/react';
import { Close, Add, Edit, TrashCan, ChevronUp } from '@carbon/icons-react';
import { useRepoMappings, useCreateRepoMapping, useUpdateRepoMapping, useDeleteRepoMapping } from '../hooks/useRepoMappings';
import { useFlatTags } from '../hooks/useTaxonomy';
import type { RepoTagMapping } from '../services/api';

interface ProjectsModalProps {
  open: boolean;
  onClose: () => void;
}

type MappingForm = {
  tagId: string;
  githubRepos: string; // newline-separated
  gitlabPaths: string;
};

function blankForm(): MappingForm {
  return { tagId: '', githubRepos: '', gitlabPaths: '' };
}

function mappingToForm(m: RepoTagMapping): MappingForm {
  return {
    tagId:       m.tagId,
    githubRepos: m.githubRepos.join('\n'),
    gitlabPaths: m.gitlabPaths.join('\n'),
  };
}

// ── ProjectsModal ─────────────────────────────────────────────────────────────

export const ProjectsModal: React.FC<ProjectsModalProps> = ({ open, onClose }) => {
  const { data: mappings = [], isPending } = useRepoMappings();
  const flatTags = useFlatTags();
  const createMapping = useCreateRepoMapping();
  const updateMapping = useUpdateRepoMapping();
  const deleteMapping = useDeleteRepoMapping();

  const [expanded,  setExpanded]  = useState<string | null>(null);
  const [editForm,  setEditForm]  = useState<MappingForm>(blankForm());
  const [addOpen,   setAddOpen]   = useState(false);
  const [addForm,   setAddForm]   = useState<MappingForm>(blankForm());
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  function startEdit(m: RepoTagMapping) {
    setExpanded(m.id);
    setEditForm(mappingToForm(m));
    setAddOpen(false);
    setError(null);
  }

  function formToPayload(f: MappingForm) {
    return {
      tagId:       f.tagId,
      githubRepos: f.githubRepos.split('\n').map((s) => s.trim()).filter(Boolean),
      gitlabPaths: f.gitlabPaths.split('\n').map((s) => s.trim()).filter(Boolean),
    };
  }

  async function saveEdit(id: string) {
    setError(null);
    if (!editForm.tagId) { setError('A tag must be selected'); return; }
    try {
      await updateMapping.mutateAsync({ id, ...formToPayload(editForm) });
      setExpanded(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Update failed'); }
  }

  async function saveAdd() {
    setError(null);
    if (!addForm.tagId) { setError('A tag must be selected'); return; }
    try {
      await createMapping.mutateAsync(formToPayload(addForm));
      setAddOpen(false);
      setAddForm(blankForm());
    } catch (e) { setError(e instanceof Error ? e.message : 'Create failed'); }
  }

  async function confirmDelete(m: RepoTagMapping) {
    if (!window.confirm(`Remove mapping for "${m.tagName}"?`)) return;
    setError(null);
    try {
      await deleteMapping.mutateAsync(m.id);
      if (expanded === m.id) setExpanded(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Delete failed'); }
  }

  const repoCount = (m: RepoTagMapping) => m.githubRepos.length + m.gitlabPaths.length;

  return (
    <>
      <div className="tag-panel-backdrop" onClick={onClose} />
      <div className="tag-panel projects-panel tag-panel--open" role="dialog" aria-label="Repo Mappings" aria-modal="true">

        {/* Header */}
        <div className="tag-panel-header">
          <div>
            <h2 className="tag-panel-title">Repo → Tag Mappings</h2>
            <p className="projects-panel__subtitle">Map GitHub repos &amp; GitLab paths to taxonomy tags</p>
          </div>
          <Button kind="ghost" size="sm" renderIcon={Close} iconDescription="Close" hasIconOnly onClick={onClose} />
        </div>

        {/* Body */}
        <div className="tag-panel-body">
          {error && (
            <InlineNotification
              kind="error"
              title={error}
              lowContrast
              hideCloseButton={false}
              onCloseButtonClick={() => { setError(null); }}
            />
          )}

          {isPending && <InlineLoading description="Loading mappings…" />}

          {mappings.map((m) => (
            <div key={m.id} className="project-row">
              {/* Summary row */}
              <div className="project-row__summary">
                {m.tagColour && (
                  <span className="project-row__swatch" style={{ background: m.tagColour }} />
                )}
                <span className="project-row__name">{m.tagName}</span>
                <span className="project-row__category">
                  {repoCount(m)} repo{repoCount(m) !== 1 ? 's' : ''}
                </span>
                <div className="project-row__actions">
                  <button
                    className="project-row__action-btn"
                    title={expanded === m.id ? 'Collapse' : 'Edit'}
                    onClick={() => { expanded === m.id ? setExpanded(null) : startEdit(m); }}
                  >
                    {expanded === m.id ? <ChevronUp size={14} /> : <Edit size={14} />}
                  </button>
                  <button
                    className="project-row__action-btn project-row__action-btn--danger"
                    title="Remove mapping"
                    onClick={() => { void confirmDelete(m); }}
                    disabled={deleteMapping.isPending}
                  >
                    <TrashCan size={14} />
                  </button>
                </div>
              </div>

              {/* Repo pills (collapsed) */}
              {expanded !== m.id && repoCount(m) > 0 && (
                <div className="project-row__repos">
                  {m.githubRepos.map((r) => (
                    <span key={r} className="project-row__repo-pill project-row__repo-pill--gh">{r}</span>
                  ))}
                  {m.gitlabPaths.map((p) => (
                    <span key={p} className="project-row__repo-pill project-row__repo-pill--gl">{p}</span>
                  ))}
                </div>
              )}

              {/* Inline edit form */}
              {expanded === m.id && (
                <div className="project-form">
                  <MappingFormFields form={editForm} onChange={setEditForm} tags={flatTags} />
                  <div className="project-form__actions">
                    <Button kind="primary" size="sm" onClick={() => { void saveEdit(m.id); }} disabled={updateMapping.isPending}>Save</Button>
                    <Button kind="ghost"   size="sm" onClick={() => { setExpanded(null); }}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {!isPending && mappings.length === 0 && (
            <p className="tag-panel-empty-state">No mappings yet. Add one below.</p>
          )}

          {/* Add new mapping */}
          {addOpen ? (
            <div className="project-form project-form--add">
              <h3 className="project-form__heading">New Mapping</h3>
              <MappingFormFields form={addForm} onChange={setAddForm} tags={flatTags} />
              <div className="project-form__actions">
                <Button kind="primary" size="sm" onClick={() => { void saveAdd(); }} disabled={createMapping.isPending}>Create</Button>
                <Button kind="ghost"   size="sm" onClick={() => { setAddOpen(false); setAddForm(blankForm()); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button
              className="tag-panel-add-child projects-add-btn"
              onClick={() => { setAddOpen(true); setExpanded(null); setError(null); }}
            >
              <Add size={14} /> Add mapping
            </button>
          )}
        </div>
      </div>
    </>
  );
};

// ── Form fields ───────────────────────────────────────────────────────────────

interface FormFieldsProps {
  form: MappingForm;
  onChange: (f: MappingForm) => void;
  tags: { id: string; name: string; colour: string | null; parentId: string | null }[];
}

const MappingFormFields: React.FC<FormFieldsProps> = ({ form, onChange, tags }) => {
  const set = (key: keyof MappingForm) =>
    (e: React.ChangeEvent<HTMLSelectElement | HTMLTextAreaElement>) => {
      onChange({ ...form, [key]: e.target.value });
    };

  return (
    <div className="project-form__fields">
      <label className="project-form__label">
        Tag (project area)
        <select className="project-form__select" value={form.tagId} onChange={set('tagId')}>
          <option value="">— select a tag —</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.parentId === null ? t.name : `  ↳ ${t.name}`}
            </option>
          ))}
        </select>
        {tags.length === 0 && (
          <span className="project-form__hint">Add tags in the Tag Manager first</span>
        )}
      </label>

      <label className="project-form__label">
        GitHub repos <span className="project-form__hint">(one per line — owner/repo)</span>
        <textarea
          className="project-form__textarea"
          value={form.githubRepos}
          onChange={set('githubRepos')}
          placeholder={'owner/repo-name\nowner/another-repo'}
          rows={3}
        />
      </label>

      <label className="project-form__label">
        GitLab paths <span className="project-form__hint">(one per line — group/project)</span>
        <textarea
          className="project-form__textarea"
          value={form.gitlabPaths}
          onChange={set('gitlabPaths')}
          placeholder={'group/project-name'}
          rows={2}
        />
      </label>
    </div>
  );
};
