import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import type { PersonRelationships as Relationships } from '../types/companies';
import { ProjectOptions } from '../components/ProjectOptions';

export function PersonRelationships({ personId }: { personId: string }): React.ReactElement {
  const qc = useQueryClient();
  const relationships = useQuery({ queryKey: ['person-relationships', personId], queryFn: async () => requireApiData(await api.getPersonRelationships(personId)) });
  const companies = useQuery({ queryKey: ['companies', ''], queryFn: async () => requireApiData(await api.getCompanies()) });
  const projects = useQuery({ queryKey: ['projects'], queryFn: async () => requireApiData(await api.getProjects()) });
  const [draft, setDraft] = useState<Relationships | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function save(): Promise<void> {
    if (!draft || saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      requireApiData(await api.savePersonRelationships(personId, draft)); setDraft(null);
      await Promise.all(['person-relationships', 'company-people', 'companies', 'company', 'entity-link', 'chat-mention-targets'].map(key => qc.invalidateQueries({ queryKey: [key] })));
    } catch (cause) { setError(describeApiError(cause)); }
    finally { saving.current = false; setBusy(false); }
  }
  const data = draft ?? relationships.data;
  const failed = relationships.error || companies.error || projects.error;
  return <section className="people-page__relationships">
    <h3>Company and programme roles</h3>
    {relationships.isPending && <p role="status">Loading relationships...</p>}
    {failed && <p className="people-page__notice people-page__notice--error" role="alert">{describeApiError(failed)}
      <button className="people-page__button" onClick={() => { void relationships.refetch(); void companies.refetch(); void projects.refetch(); }}>Retry</button></p>}
    {error && <p className="people-page__notice people-page__notice--error" role="alert">{error}</p>}
    {data && !draft && <>
      {data.companyId ? <Link to={`/companies?companyId=${encodeURIComponent(data.companyId)}`}>{companies.data?.find(item => item.id === data.companyId)?.name ?? 'Open company'}</Link> : <p>No company record linked. Legacy organisation text above is unchanged.</p>}
      {data.assignments.map(row => <div className="people-page__relationship" key={row.projectId}>
        <Link to={`/projects?projectId=${encodeURIComponent(row.projectId)}`}>{projects.data?.find(item => item.id === row.projectId)?.name ?? row.projectId}</Link>
        <span>{row.role || 'Role not recorded'}</span>
        {row.companyId && <Link to={`/companies?companyId=${encodeURIComponent(row.companyId)}`}>Representing {companies.data?.find(item => item.id === row.companyId)?.name ?? 'company'}</Link>}
      </div>)}
      {!data.assignments.length && <p>No programme roles recorded.</p>}
      <div className="people-page__actions"><button className="people-page__button" disabled={!!failed || companies.isPending || projects.isPending}
        onClick={() => { setDraft({ ...data, assignments: data.assignments.map(row => ({ ...row })) }); }}>Edit relationships</button></div>
    </>}
    {draft && <form className="people-page__form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Company<select value={draft.companyId ?? ''} disabled={busy} onChange={event => { setDraft({ ...draft, companyId: event.target.value || null }); }}>
        <option value="">No company linked</option>{companies.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {draft.assignments.map((row, index) => <fieldset key={index} disabled={busy}>
        <legend>Programme role {index + 1}</legend>
        <label>Project<select required value={row.projectId} onChange={event => { setDraft({ ...draft, assignments: draft.assignments.map((item, i) => i === index ? { ...item, projectId: event.target.value } : item) }); }}>
          <option value="">Choose project</option><ProjectOptions projects={projects.data ?? []} selected={row.projectId} />
        </select></label>
        <label>Representing<select value={row.companyId ?? ''} onChange={event => { setDraft({ ...draft, assignments: draft.assignments.map((item, i) => i === index ? { ...item, companyId: event.target.value || null } : item) }); }}>
          <option value="">No company specified</option>{companies.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>Role<input maxLength={1000} value={row.role} onChange={event => { setDraft({ ...draft, assignments: draft.assignments.map((item, i) => i === index ? { ...item, role: event.target.value } : item) }); }} /></label>
        <button type="button" className="people-page__button people-page__button--danger" onClick={() => { setDraft({ ...draft, assignments: draft.assignments.filter((_, i) => i !== index) }); }}>Remove role</button>
      </fieldset>)}
      <div className="people-page__actions">
        <button type="button" className="people-page__button" disabled={busy || draft.assignments.length >= 100} onClick={() => { setDraft({ ...draft, assignments: [...draft.assignments, { projectId: '', role: '', companyId: draft.companyId }] }); }}>Add programme role</button>
        <button className="people-page__button people-page__button--primary" disabled={busy}>{busy ? 'Saving...' : 'Save relationships'}</button>
        <button type="button" className="people-page__button" disabled={busy} onClick={() => { setDraft(null); }}>Cancel</button>
      </div>
    </form>}
  </section>;
}
