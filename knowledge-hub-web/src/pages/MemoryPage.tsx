/**
 * pages/MemoryPage.tsx — everything Athena has learned from you, in one
 * place: suggestions to approve, standing instructions by scope (edit, pause,
 * delete), liked example replies, and your profile.
 */
import React, { useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ComboBox, InlineLoading, InlineNotification } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { api } from '../services/api';
import { confirmDialog } from '../services/appDialogs';
import type { AthenaMemory, MemoryScopeType } from '../types';
import { PERSONAS } from '../components/athena/personas';
import { useProjects } from '../hooks/useProjects';
import { groupProjectsByParent } from '../components/ProjectOptions';
import { describeApiError, requireApiData } from '../services/apiError';
import type { ApiResponse } from '../types/apiResponse';
import { PageHeader } from '../components/PageHeader';

type MemoryAction = (key: string, action: () => Promise<ApiResponse<unknown>>, onSaved?: () => void) => Promise<void>;

const SCOPE_TITLES: Record<MemoryScopeType, string> = {
  global: 'Everywhere',
  persona: 'Per persona',
  project: 'Per project',
  output: 'Per kind of output',
};

function scopeLabel(m: Pick<AthenaMemory, 'scopeType' | 'scopeValue'>, projects: Array<{ id: string; name: string }> = []): string {
  if (m.scopeType === 'global') return 'Everywhere';
  if (m.scopeType === 'persona') return PERSONAS.find((p) => p.id === m.scopeValue)?.label ?? m.scopeValue ?? '';
  if (m.scopeType === 'output') return `When producing: ${m.scopeValue ?? ''}`;
  return `Project: ${projects.find((project) => project.id === m.scopeValue)?.name ?? m.scopeValue ?? ''}`;
}

function when(iso: string | null): string {
  if (iso === null) return 'not used yet';
  return `last used ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

const ORIGIN_LABEL: Record<AthenaMemory['origin'], string> = {
  chat: 'from chat', feedback: 'from your 👎 feedback', weekly: 'from the weekly review', manual: 'added here', 'profile-import': 'imported',
};

/** Scope picker used when adding or editing an instruction. */
const ScopeFields: React.FC<{ scopeType: MemoryScopeType; scopeValue: string; disabled?: boolean; onChange: (t: MemoryScopeType, v: string) => void }> = ({ scopeType, scopeValue, disabled = false, onChange }) => {
  const projectPickerId = useId();
  const { data: projects = [], error, refetch } = useProjects();
  const options = groupProjectsByParent(projects, [scopeValue]).flatMap(group =>
    group.projects.map(project => ({ id: project.id, name: `${group.label} / ${project.name}` })));
  if (scopeValue !== '' && !options.some((project) => project.id === scopeValue)) {
    options.push({ id: scopeValue, name: `Legacy / unknown project: ${scopeValue}` });
  }
  return <>
    <select className="memory-select" disabled={disabled} value={scopeType} aria-label="Applies to" onChange={(e) => { onChange(e.target.value as MemoryScopeType, ''); }}>
      <option value="global">Everywhere</option>
      <option value="persona">One persona</option>
      <option value="project">One project</option>
      <option value="output">One kind of output</option>
    </select>
    {scopeType === 'persona' && (
      <select className="memory-select" disabled={disabled} value={scopeValue} aria-label="Persona" onChange={(e) => { onChange(scopeType, e.target.value); }}>
        <option value="">Choose…</option>
        {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    )}
    {scopeType === 'project' && <div className="memory-project-picker">
      <ComboBox id={projectPickerId} titleText="Project" disabled={disabled} items={options}
        selectedItem={options.find((project) => project.id === scopeValue) ?? null}
        itemToString={(project) => project?.name ?? ''} placeholder="Search projects"
        onChange={({ selectedItem }) => { onChange(scopeType, selectedItem?.id ?? ''); }} />
      {error !== null && <div className="memory-notice" role="alert">
        Could not load projects. <button type="button" className="kb-import-btn" onClick={() => { void refetch(); }}>Retry</button>
      </div>}
    </div>}
    {scopeType === 'output' && (
      <input className="memory-input memory-input--short" disabled={disabled} value={scopeValue} aria-label="Kind of output"
        placeholder="e.g. blog post" onChange={(e) => { onChange(scopeType, e.target.value); }} />
    )}
  </>;
};

const InstructionRow: React.FC<{ m: AthenaMemory; run: MemoryAction; busy: boolean; scopeText: string }> = ({ m, run, busy, scopeText }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ content: m.content, scopeType: m.scopeType, scopeValue: m.scopeValue ?? '' });
  const paused = m.status === 'paused';
  const save = (): void => {
    void run(m.id, () => api.updateMemory(m.id, { content: draft.content, scopeType: draft.scopeType, scopeValue: draft.scopeType === 'global' ? null : draft.scopeValue }), () => { setEditing(false); });
  };
  return (
    <li className={`memory-item${paused ? ' memory-item--paused' : ''}`}>
      {editing ? (
        <div className="memory-edit">
          <textarea className="memory-input" disabled={busy} rows={2} value={draft.content} aria-label="Instruction" onChange={(e) => { setDraft({ ...draft, content: e.target.value }); }} />
          <div className="memory-row">
            <ScopeFields disabled={busy} scopeType={draft.scopeType} scopeValue={draft.scopeValue} onChange={(t, v) => { setDraft({ ...draft, scopeType: t, scopeValue: v }); }} />
            <button type="button" className="kb-import-btn" disabled={busy || draft.content.trim() === '' || (draft.scopeType !== 'global' && draft.scopeValue.trim() === '')} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
            <button type="button" className="kb-import-btn" disabled={busy} onClick={() => { setEditing(false); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="memory-item__text">{m.content}</p>
          <p className="memory-item__meta">{scopeText} · {ORIGIN_LABEL[m.origin]} · {paused ? 'paused' : when(m.lastAppliedAt)}</p>
          <div className="memory-item__actions">
            <button type="button" className="kb-import-btn" disabled={busy} onClick={() => { setEditing(true); }}>Edit</button>
            <button type="button" className="kb-import-btn" disabled={busy} onClick={() => { void run(m.id, () => api.updateMemory(m.id, { status: paused ? 'active' : 'paused' })); }}>{paused ? 'Resume' : 'Pause'}</button>
            <button type="button" className="kb-import-btn kb-import-btn--danger" disabled={busy} onClick={async () => { if (await confirmDialog('Delete this instruction?', { title: 'Delete instruction', confirmLabel: 'Delete', tone: 'danger' })) void run(m.id, () => api.deleteMemory(m.id)); }}>Delete</button>
          </div>
        </>
      )}
    </li>
  );
};

export const MemoryPage: React.FC = () => {
  const qc = useQueryClient();
  const { data: memories = [], isLoading, error: loadError, refetch } = useQuery({
    queryKey: ['memories'],
    queryFn: async () => requireApiData(await api.listMemories()).memories,
  });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ['memories'] }); };
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState({ content: '', scopeType: 'global' as MemoryScopeType, scopeValue: '' });
  const profile = memories.find((m) => m.kind === 'profile');
  const [profileDraft, setProfileDraft] = useState<string | null>(null);
  const { data: projects = [] } = useProjects();
  const busyRef = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState(new Set<string>());
  const [actionError, setActionError] = useState<string | null>(null);

  const run: MemoryAction = async (key, action, onSaved) => {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusyIds(new Set(busyRef.current));
    setActionError(null);
    try {
      requireApiData(await action());
      onSaved?.();
      refresh();
    } catch (error) {
      setActionError(describeApiError(error));
    } finally {
      busyRef.current.delete(key);
      setBusyIds(new Set(busyRef.current));
    }
  };

  const suggestions = memories.filter((m) => m.status === 'suggested');
  const instructions = memories.filter((m) => m.kind === 'instruction' && (m.status === 'active' || m.status === 'paused'));
  const examples = memories.filter((m) => m.kind === 'example' && m.status === 'active');
  const byScope = useMemo(() => (['global', 'persona', 'project', 'output'] as MemoryScopeType[])
    .map((scope) => ({ scope, items: instructions.filter((m) => m.scopeType === scope) }))
    .filter((g) => g.items.length > 0), [instructions]);

  const addInstruction = (): void => {
    if (newItem.content.trim() === '') return;
    void run('new', () => api.createMemory({ content: newItem.content, scopeType: newItem.scopeType, scopeValue: newItem.scopeType === 'global' ? null : newItem.scopeValue }),
      () => { setAdding(false); setNewItem({ content: '', scopeType: 'global', scopeValue: '' }); });
  };

  return (
    <main className="memory-page">
      <PageHeader title="Memory" subtitle="What Athena has learned from you — she follows these in every matching conversation." actions={
        <button type="button" className="docs-upload-btn" onClick={() => { setAdding(true); }}><Add size={20} /> Add instruction</button>
      } />

      {isLoading && <InlineLoading description="Loading memory…" />}
      {loadError !== null && <div className="memory-notice">
        <InlineNotification kind="error" title="Memory is unavailable" subtitle={describeApiError(loadError)} lowContrast hideCloseButton />
        <button type="button" className="kb-import-btn" onClick={() => { void refetch(); }}>Retry</button>
      </div>}
      {actionError !== null && <InlineNotification className="memory-notice" kind="error" title="Change was not saved" subtitle={actionError} lowContrast hideCloseButton />}

      {adding && (
        <section className="memory-section memory-add">
          <textarea className="memory-input" disabled={busyIds.has('new')} rows={2} autoFocus placeholder="e.g. Always use UK spelling" aria-label="New instruction"
            value={newItem.content} onChange={(e) => { setNewItem({ ...newItem, content: e.target.value }); }} />
          <div className="memory-row">
            <ScopeFields disabled={busyIds.has('new')} scopeType={newItem.scopeType} scopeValue={newItem.scopeValue} onChange={(t, v) => { setNewItem({ ...newItem, scopeType: t, scopeValue: v }); }} />
            <button type="button" className="kb-import-btn" disabled={busyIds.has('new') || newItem.content.trim() === '' || (newItem.scopeType !== 'global' && newItem.scopeValue.trim() === '')} onClick={addInstruction}>{busyIds.has('new') ? 'Saving...' : 'Save'}</button>
            <button type="button" className="kb-import-btn" disabled={busyIds.has('new')} onClick={() => { setAdding(false); }}>Cancel</button>
          </div>
        </section>
      )}

      {suggestions.length > 0 && (
        <section className="memory-section memory-section--suggestions">
          <h2 className="memory-section__title">Suggestions to review ({suggestions.length})</h2>
          <ul className="memory-list">
            {suggestions.map((m) => (
              <li key={m.id} className="memory-item">
                <p className="memory-item__text">{m.content}</p>
                <p className="memory-item__meta">{scopeLabel(m, projects)} · {ORIGIN_LABEL[m.origin]}{m.sourceExcerpt ? ` · “${m.sourceExcerpt.slice(0, 120)}”` : ''}</p>
                <div className="memory-item__actions">
                  <button type="button" className="kb-import-btn" disabled={busyIds.has(m.id)} onClick={() => { void run(m.id, () => api.updateMemory(m.id, { status: 'active' })); }}>Approve</button>
                  <button type="button" className="kb-import-btn" disabled={busyIds.has(m.id)} onClick={() => { void run(m.id, () => api.updateMemory(m.id, { status: 'dismissed' })); }}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="memory-section">
        <h2 className="memory-section__title">Standing instructions ({instructions.length})</h2>
        {!isLoading && loadError === null && instructions.length === 0 && <p className="memory-empty">None yet. Tell Athena “from now on…” in any chat, or add one here.</p>}
        {byScope.map((g) => (
          <div key={g.scope} className="memory-group">
            <h3 className="memory-group__title">{SCOPE_TITLES[g.scope]}</h3>
            <ul className="memory-list">{g.items.map((m) => <InstructionRow key={m.id} m={m} run={run} busy={busyIds.has(m.id)} scopeText={scopeLabel(m, projects)} />)}</ul>
          </div>
        ))}
      </section>

      <section className="memory-section">
        <h2 className="memory-section__title">Replies you liked ({examples.length})</h2>
        {!isLoading && loadError === null && examples.length === 0 && <p className="memory-empty">Use 👍 on a reply and Athena will use it as a reference for that persona.</p>}
        <ul className="memory-list">
          {examples.map((m) => (
            <li key={m.id} className="memory-item">
              <details>
                <summary className="memory-item__text">{m.content.replace(/\s+/g, ' ').slice(0, 160)}…</summary>
                <pre className="memory-example">{m.content}</pre>
              </details>
              <p className="memory-item__meta">{scopeLabel(m, projects)} · {when(m.lastAppliedAt)}</p>
              <div className="memory-item__actions">
                <button type="button" className="kb-import-btn kb-import-btn--danger" disabled={busyIds.has(m.id)} onClick={() => { void run(m.id, () => api.deleteMemory(m.id)); }}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {profile !== undefined && (
        <section className="memory-section">
          <h2 className="memory-section__title">About you (profile Athena always uses)</h2>
          <textarea className="memory-input memory-profile" disabled={busyIds.has(profile.id)} rows={12} aria-label="Profile"
            value={profileDraft ?? profile.content} onChange={(e) => { setProfileDraft(e.target.value); }} />
          <div className="memory-row">
            <button type="button" className="kb-import-btn" disabled={busyIds.has(profile.id) || profileDraft === null || profileDraft === profile.content}
              onClick={() => { void run(profile.id, () => api.updateMemory(profile.id, { content: profileDraft ?? profile.content }), () => { setProfileDraft(null); }); }}>
              Save profile
            </button>
          </div>
        </section>
      )}
    </main>
  );
};
