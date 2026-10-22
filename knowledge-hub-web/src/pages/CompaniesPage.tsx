import React, { useDeferredValue, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import { PageHeader } from '../components/PageHeader';
import { NoteBacklinks } from '../notes/NoteBacklinks';
import type { CompanyInput } from '../types/companies';

export function CompaniesPage(): React.ReactElement {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const id = params.get('companyId');
  const qc = useQueryClient();
  const companies = useQuery({ queryKey: ['companies', query], queryFn: async () => requireApiData(await api.getCompanies(query)) });
  const company = useQuery({ queryKey: ['company', id], enabled: !!id, queryFn: async () => requireApiData(await api.getCompany(id!)) });
  const people = useQuery({ queryKey: ['company-people', id], enabled: !!id, queryFn: async () => requireApiData(await api.getCompanyPeople(id!)) });
  const projects = useQuery({ queryKey: ['projects'], queryFn: async () => requireApiData(await api.getProjects()) });
  const [editing, setEditing] = useState<{ id?: string; input: CompanyInput } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function save(input: CompanyInput): Promise<void> {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = requireApiData(await api.saveCompany(input, editing?.id));
      setParams({ companyId: result.id }); setEditing(null);
      await Promise.all(['companies', 'company', 'company-people', 'entity-link', 'entity-link-search', 'chat-mention-targets'].map(key => qc.invalidateQueries({ queryKey: [key] })));
    } catch (cause) { setError(describeApiError(cause)); }
    finally { saving.current = false; setBusy(false); }
  }
  const projectName = (key: string): string => projects.data?.find(project => project.id === key)?.name ?? key;
  return <section className="people-page">
    <PageHeader title="Companies" subtitle="Companies, their people and the programmes they work on. Create or mention a company with @." />
    <div className="people-page__toolbar">
      <label className="people-page__search">Search companies<input type="search" maxLength={200} value={search} onChange={event => { setSearch(event.target.value); }} /></label>
      <button type="button" className="people-page__button" disabled={busy} onClick={() => { setEditing({ input: { name: '', description: '', website: '', projectIds: [] } }); setError(''); }}>Add company</button>
      <Link to="/people" className="people-page__button">People</Link>
    </div>
    {error && <p className="people-page__notice people-page__notice--error" role="alert">{error}</p>}
    {companies.error && <p className="people-page__notice people-page__notice--error" role="alert">{describeApiError(companies.error)} <button className="people-page__button" onClick={() => { void companies.refetch(); }}>Retry</button></p>}
    {editing && <CompanyForm key={editing.id ?? 'new'} initial={editing.input} projects={projects.data ?? []} busy={busy} projectsError={projects.error}
      onSave={input => { void save(input); }} onCancel={() => { setEditing(null); }} />}
    <div className="people-page__layout">
      <div className="people-page__list" aria-label="Companies">
        {companies.isPending && <p role="status">Loading companies...</p>}
        {companies.data?.length === 0 && <p>{query ? 'No matching companies.' : 'No companies yet. Add one here or create one from an @mention.'}</p>}
        {companies.data?.map(item => <button type="button" key={item.id} className={`people-page__person${item.id === id ? ' people-page__person--selected' : ''}`}
          aria-pressed={item.id === id} onClick={() => { setParams({ companyId: item.id }); setEditing(null); setError(''); }}>
          <strong>{item.name}</strong><span>{item.description || 'No description recorded'}</span>
        </button>)}
      </div>
      {id && !editing && <section className="people-page__panel" aria-label="Company details">
        {company.isPending && <p role="status">Loading company...</p>}
        {company.error && <p role="alert">{describeApiError(company.error)} <button className="people-page__button" onClick={() => { void company.refetch(); }}>Retry</button></p>}
        {company.data && <>
          <h2>{company.data.name}</h2><p>{company.data.description || 'No description recorded.'}</p>
          {/^https?:\/\//i.test(company.data.website) && <a href={company.data.website} target="_blank" rel="noopener noreferrer">{company.data.website}</a>}
          <div className="people-page__actions"><button className="people-page__button" onClick={() => { setEditing({ id, input: company.data }); }}>Edit company</button></div>
          <h3>Programmes / projects</h3>
          {projects.error && <p role="alert">Project names could not be loaded. <button className="people-page__button" onClick={() => { void projects.refetch(); }}>Retry</button></p>}
          {company.data.projectIds.length ? company.data.projectIds.map(key => <Link key={key} to={`/projects?projectId=${encodeURIComponent(key)}`}>{projectName(key)}</Link>) : <p>No programme links recorded.</p>}
          <h3>People and representatives</h3>
          {people.isPending && <p role="status">Loading people...</p>}
          {people.error && <p role="alert">{describeApiError(people.error)} <button className="people-page__button" onClick={() => { void people.refetch(); }}>Retry</button></p>}
          {people.data?.length === 0 && <p>No people linked. Open a person page to record their company and programme roles.</p>}
          {people.data?.map(person => <div key={`${person.id}:${person.projectId ?? ''}`} className="people-page__relationship">
            <Link to={`/people?personId=${encodeURIComponent(person.id)}`}>{person.name}</Link>
            <span>{person.role || 'Role not recorded'}</span>
            {person.projectId && <Link to={`/projects?projectId=${encodeURIComponent(person.projectId)}`}>{projectName(person.projectId)}</Link>}
          </div>)}
          <NoteBacklinks type="company" noteId={id} />
        </>}
      </section>}
    </div>
  </section>;
}

function CompanyForm({ initial, projects, projectsError, busy, onSave, onCancel }: {
  initial: CompanyInput; projects: Array<{ id: string; name: string }>; projectsError: unknown; busy: boolean;
  onSave: (input: CompanyInput) => void; onCancel: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(initial);
  return <form className="people-page__panel people-page__form" onSubmit={event => { event.preventDefault(); onSave(draft); }}>
    <h2>Company details</h2>
    <label>Name<input required maxLength={200} value={draft.name} disabled={busy} onChange={event => { setDraft({ ...draft, name: event.target.value }); }} /></label>
    <label>Description<textarea maxLength={10000} rows={4} value={draft.description} disabled={busy} onChange={event => { setDraft({ ...draft, description: event.target.value }); }} /></label>
    <label>Website<input type="url" maxLength={2000} value={draft.website} disabled={busy} onChange={event => { setDraft({ ...draft, website: event.target.value }); }} /></label>
    <fieldset disabled={busy || !!projectsError}><legend>Programmes / projects</legend>
      {projectsError ? <p role="alert">Project lookup failed. Existing links will be retained.</p> : projects.map(project => <label key={project.id} className="people-page__checkbox">
        <input type="checkbox" checked={draft.projectIds.includes(project.id)} onChange={event => {
          setDraft({ ...draft, projectIds: event.target.checked ? [...draft.projectIds, project.id] : draft.projectIds.filter(key => key !== project.id) });
        }} />{project.name}
      </label>)}
    </fieldset>
    <div className="people-page__actions"><button className="people-page__button people-page__button--primary" disabled={busy || !draft.name.trim()}>{busy ? 'Saving...' : 'Save company'}</button>
      <button type="button" className="people-page__button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
