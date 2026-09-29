/**
 * pages/MemoryPage.tsx — everything Athena has learned from you, in one
 * place: suggestions to approve, standing instructions by scope (edit, pause,
 * delete), liked example replies, and your profile.
 */
import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { api } from '../services/api';
import type { AthenaMemory, MemoryScopeType } from '../types';
import { PERSONAS } from '../components/athena/personas';

const SCOPE_TITLES: Record<MemoryScopeType, string> = {
  global: 'Everywhere',
  persona: 'Per persona',
  project: 'Per project',
  output: 'Per kind of output',
};

function scopeLabel(m: Pick<AthenaMemory, 'scopeType' | 'scopeValue'>): string {
  if (m.scopeType === 'global') return 'Everywhere';
  if (m.scopeType === 'persona') return PERSONAS.find((p) => p.id === m.scopeValue)?.label ?? m.scopeValue ?? '';
  if (m.scopeType === 'output') return `When producing: ${m.scopeValue ?? ''}`;
  return `Project: ${m.scopeValue ?? ''}`;
}

function when(iso: string | null): string {
  if (iso === null) return 'not used yet';
  return `last used ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

const ORIGIN_LABEL: Record<AthenaMemory['origin'], string> = {
  chat: 'from chat', feedback: 'from your 👎 feedback', weekly: 'from the weekly review', manual: 'added here', 'profile-import': 'imported',
};

/** Scope picker used when adding or editing an instruction. */
const ScopeFields: React.FC<{ scopeType: MemoryScopeType; scopeValue: string; onChange: (t: MemoryScopeType, v: string) => void }> = ({ scopeType, scopeValue, onChange }) => (
  <>
    <select className="memory-select" value={scopeType} aria-label="Applies to" onChange={(e) => { onChange(e.target.value as MemoryScopeType, ''); }}>
      <option value="global">Everywhere</option>
      <option value="persona">One persona</option>
      <option value="project">One project</option>
      <option value="output">One kind of output</option>
    </select>
    {scopeType === 'persona' && (
      <select className="memory-select" value={scopeValue} aria-label="Persona" onChange={(e) => { onChange(scopeType, e.target.value); }}>
        <option value="">Choose…</option>
        {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    )}
    {(scopeType === 'project' || scopeType === 'output') && (
      <input className="memory-input memory-input--short" value={scopeValue} aria-label={scopeType === 'project' ? 'Project id' : 'Kind of output'}
        placeholder={scopeType === 'project' ? 'e.g. imagine' : 'e.g. blog post'} onChange={(e) => { onChange(scopeType, e.target.value); }} />
    )}
  </>
);

const InstructionRow: React.FC<{ m: AthenaMemory; onChanged: () => void }> = ({ m, onChanged }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ content: m.content, scopeType: m.scopeType, scopeValue: m.scopeValue ?? '' });
  const paused = m.status === 'paused';
  const save = (): void => {
    void api.updateMemory(m.id, { content: draft.content, scopeType: draft.scopeType, scopeValue: draft.scopeType === 'global' ? null : draft.scopeValue }).then(() => { setEditing(false); onChanged(); });
  };
  return (
    <li className={`memory-item${paused ? ' memory-item--paused' : ''}`}>
      {editing ? (
        <div className="memory-edit">
          <textarea className="memory-input" rows={2} value={draft.content} aria-label="Instruction" onChange={(e) => { setDraft({ ...draft, content: e.target.value }); }} />
          <div className="memory-row">
            <ScopeFields scopeType={draft.scopeType} scopeValue={draft.scopeValue} onChange={(t, v) => { setDraft({ ...draft, scopeType: t, scopeValue: v }); }} />
            <button type="button" className="kb-import-btn" onClick={save}>Save</button>
            <button type="button" className="kb-import-btn" onClick={() => { setEditing(false); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="memory-item__text">{m.content}</p>
          <p className="memory-item__meta">{scopeLabel(m)} · {ORIGIN_LABEL[m.origin]} · {paused ? 'paused' : when(m.lastAppliedAt)}</p>
          <div className="memory-item__actions">
            <button type="button" className="kb-import-btn" onClick={() => { setEditing(true); }}>Edit</button>
            <button type="button" className="kb-import-btn" onClick={() => { void api.updateMemory(m.id, { status: paused ? 'active' : 'paused' }).then(onChanged); }}>{paused ? 'Resume' : 'Pause'}</button>
            <button type="button" className="kb-import-btn kb-import-btn--danger" onClick={() => { if (window.confirm('Delete this instruction?')) void api.deleteMemory(m.id).then(onChanged); }}>Delete</button>
          </div>
        </>
      )}
    </li>
  );
};

export const MemoryPage: React.FC = () => {
  const qc = useQueryClient();
  const { data: memories = [], isLoading } = useQuery({
    queryKey: ['memories'],
    queryFn: async () => { const r = await api.listMemories(); return r.success ? r.data.memories : []; },
  });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ['memories'] }); };
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState({ content: '', scopeType: 'global' as MemoryScopeType, scopeValue: '' });
  const profile = memories.find((m) => m.kind === 'profile');
  const [profileDraft, setProfileDraft] = useState<string | null>(null);

  const suggestions = memories.filter((m) => m.status === 'suggested');
  const instructions = memories.filter((m) => m.kind === 'instruction' && (m.status === 'active' || m.status === 'paused'));
  const examples = memories.filter((m) => m.kind === 'example' && m.status === 'active');
  const byScope = useMemo(() => (['global', 'persona', 'project', 'output'] as MemoryScopeType[])
    .map((scope) => ({ scope, items: instructions.filter((m) => m.scopeType === scope) }))
    .filter((g) => g.items.length > 0), [instructions]);

  const addInstruction = (): void => {
    if (newItem.content.trim() === '') return;
    void api.createMemory({ content: newItem.content, scopeType: newItem.scopeType, scopeValue: newItem.scopeType === 'global' ? null : newItem.scopeValue })
      .then(() => { setAdding(false); setNewItem({ content: '', scopeType: 'global', scopeValue: '' }); refresh(); });
  };

  return (
    <div className="memory-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Memory</h1>
          <p className="page-subtitle">What Athena has learned from you — she follows these in every matching conversation.</p>
        </div>
        <button type="button" className="docs-upload-btn" onClick={() => { setAdding(true); }}><Add size={20} /> Add instruction</button>
      </div>

      {isLoading && <InlineLoading description="Loading memory…" />}

      {adding && (
        <section className="memory-section memory-add">
          <textarea className="memory-input" rows={2} autoFocus placeholder="e.g. Always use UK spelling" aria-label="New instruction"
            value={newItem.content} onChange={(e) => { setNewItem({ ...newItem, content: e.target.value }); }} />
          <div className="memory-row">
            <ScopeFields scopeType={newItem.scopeType} scopeValue={newItem.scopeValue} onChange={(t, v) => { setNewItem({ ...newItem, scopeType: t, scopeValue: v }); }} />
            <button type="button" className="kb-import-btn" onClick={addInstruction}>Save</button>
            <button type="button" className="kb-import-btn" onClick={() => { setAdding(false); }}>Cancel</button>
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
                <p className="memory-item__meta">{scopeLabel(m)} · {ORIGIN_LABEL[m.origin]}{m.sourceExcerpt ? ` · “${m.sourceExcerpt.slice(0, 120)}”` : ''}</p>
                <div className="memory-item__actions">
                  <button type="button" className="kb-import-btn" onClick={() => { void api.updateMemory(m.id, { status: 'active' }).then(refresh); }}>Approve</button>
                  <button type="button" className="kb-import-btn" onClick={() => { void api.updateMemory(m.id, { status: 'dismissed' }).then(refresh); }}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="memory-section">
        <h2 className="memory-section__title">Standing instructions ({instructions.length})</h2>
        {instructions.length === 0 && <p className="memory-empty">None yet. Tell Athena “from now on…” in any chat, or add one here.</p>}
        {byScope.map((g) => (
          <div key={g.scope} className="memory-group">
            <h3 className="memory-group__title">{SCOPE_TITLES[g.scope]}</h3>
            <ul className="memory-list">{g.items.map((m) => <InstructionRow key={m.id} m={m} onChanged={refresh} />)}</ul>
          </div>
        ))}
      </section>

      <section className="memory-section">
        <h2 className="memory-section__title">Replies you liked ({examples.length})</h2>
        {examples.length === 0 && <p className="memory-empty">Use 👍 on a reply and Athena will use it as a reference for that persona.</p>}
        <ul className="memory-list">
          {examples.map((m) => (
            <li key={m.id} className="memory-item">
              <details>
                <summary className="memory-item__text">{m.content.replace(/\s+/g, ' ').slice(0, 160)}…</summary>
                <pre className="memory-example">{m.content}</pre>
              </details>
              <p className="memory-item__meta">{scopeLabel(m)} · {when(m.lastAppliedAt)}</p>
              <div className="memory-item__actions">
                <button type="button" className="kb-import-btn kb-import-btn--danger" onClick={() => { void api.deleteMemory(m.id).then(refresh); }}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {profile !== undefined && (
        <section className="memory-section">
          <h2 className="memory-section__title">About you (profile Athena always uses)</h2>
          <textarea className="memory-input memory-profile" rows={12} aria-label="Profile"
            value={profileDraft ?? profile.content} onChange={(e) => { setProfileDraft(e.target.value); }} />
          <div className="memory-row">
            <button type="button" className="kb-import-btn" disabled={profileDraft === null || profileDraft === profile.content}
              onClick={() => { void api.updateMemory(profile.id, { content: profileDraft ?? profile.content }).then(() => { setProfileDraft(null); refresh(); }); }}>
              Save profile
            </button>
          </div>
        </section>
      )}
    </div>
  );
};
