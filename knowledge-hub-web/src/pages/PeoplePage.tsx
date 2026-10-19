import React, { useDeferredValue, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import { confirmDialog } from '../services/appDialogs';
import { EMPTY_PERSON, type Person, type PersonInput } from '../types/people';
import { parsePeopleReport } from '../people/importPeople';

export function PeoplePage(): React.ReactElement {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const people = useQuery({ queryKey: ['people', query], queryFn: async () => requireApiData(await api.getPeople(query)) });
  const selectedId = params.get('personId');
  const selected = useQuery({
    queryKey: ['person', selectedId], enabled: !!selectedId,
    queryFn: async () => requireApiData(await api.getPerson(selectedId!)),
  });
  const [editing, setEditing] = useState<{ id?: string; input: PersonInput } | null>(null);
  const [preview, setPreview] = useState<PersonInput[] | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const refresh = async (): Promise<void> => {
    await Promise.all(['people', 'person', 'entity-link', 'entity-link-search'].map(key => qc.invalidateQueries({ queryKey: [key] })));
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice('');
    try { await action(); await refresh(); }
    catch (caught) { setError(describeApiError(caught)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const importFile = async (file: File): Promise<void> => {
    setError(null); setNotice('');
    try {
      if (file.size > 500_000) throw new Error('The contact report must be smaller than 500 KB.');
      setPreview(parsePeopleReport(await file.text()));
      setEditing(null);
    } catch (caught) { setError(describeApiError(caught)); }
  };
  const openPerson = (person: Person): void => {
    setParams({ personId: person.id }); setEditing(null); setPreview(null); setError(null);
  };
  return <section className="people-page">
    <PageHeader title="People" subtitle="Your contacts, organisations and working relationships. Mention people with @ in notes or Athena chat." />
    <div className="people-page__toolbar">
      <label className="people-page__search">Search people
        <input type="search" value={search} maxLength={200} placeholder="Name, email, organisation or topic"
          onChange={event => { setSearch(event.target.value); }} />
      </label>
      <button className="people-page__button" disabled={busy} onClick={() => { setEditing({ input: { ...EMPTY_PERSON } }); setPreview(null); }}>Add person</button>
      <button className="people-page__button" disabled={busy} onClick={() => { upload.current?.click(); }}>Import contact report</button>
      <input ref={upload} className="people-page__upload" type="file" accept=".md,.markdown,text/markdown,text/plain" aria-label="Contact report"
        onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
    </div>
    {error && <p className="people-page__notice people-page__notice--error" role="alert">{error}</p>}
    {notice && <p className="people-page__notice" role="status">{notice}</p>}
    {people.error && <p className="people-page__notice people-page__notice--error" role="alert">
      {describeApiError(people.error)} <button className="people-page__button" onClick={() => { void people.refetch(); }}>Retry</button>
    </p>}
    {preview && <section className="people-page__panel" aria-label="Import preview">
      <h2>Review {preview.length} people before importing</h2>
      <p>Duplicate names in the report are combined, with all email addresses retained. Existing contacts match by email, or name and organisation.
        Reimporting updates the report snapshot; counts are not added again. Your existing notes and role are retained.</p>
      <div className="people-page__table-wrap"><table>
        <thead><tr><th>Name</th><th>Email addresses</th><th>Organisation</th><th>Emails sent</th></tr></thead>
        <tbody>{preview.map(person => <tr key={person.name}><td>{person.name}</td><td>{person.emails.join(', ')}</td><td>{person.organisation}</td><td>{person.emailCount ?? 'Not recorded'}</td></tr>)}</tbody>
      </table></div>
      <div className="people-page__actions">
        <button className="people-page__button people-page__button--primary" disabled={busy} onClick={() => { void run(async () => {
          const result = requireApiData(await api.importPeople(preview));
          setNotice(`Imported: ${result.created} created, ${result.updated} updated.`); setPreview(null);
        }); }}>{busy ? 'Importing...' : 'Import people'}</button>
        <button className="people-page__button" disabled={busy} onClick={() => { setPreview(null); }}>Cancel</button>
      </div>
    </section>}
    {editing && <PersonForm key={editing.id ?? 'new'} initial={editing.input} busy={busy}
      onCancel={() => { setEditing(null); }} onSave={input => { void run(async () => {
        const person = requireApiData(await api.savePerson(input, editing.id));
        setEditing(null); setParams({ personId: person.id }); setNotice('Person saved.');
      }); }} />}
    <div className="people-page__layout">
      <div className="people-page__list" aria-label="People">
        {people.isPending && <p role="status">Loading people...</p>}
        {!people.isPending && !people.error && !people.data?.length && <p>{search ? 'No matching people.' : 'No people yet. Add a person or import your contact report.'}</p>}
        {people.data?.map(person => <button key={person.id} type="button"
          className={`people-page__person${selectedId === person.id ? ' people-page__person--selected' : ''}`}
          aria-pressed={selectedId === person.id} onClick={() => { openPerson(person); }}>
          <strong>{person.name}</strong><span>{person.organisation || 'No organisation'}</span><small>{person.emails.join(' / ') || 'No email recorded'}</small>
        </button>)}
      </div>
      {selectedId && !preview && !editing && <section className="people-page__panel" aria-label="Person details">
        {selected.isPending && <p role="status">Loading person...</p>}
        {selected.error && <p role="alert">{describeApiError(selected.error)} <button className="people-page__button" onClick={() => { void selected.refetch(); }}>Retry</button></p>}
        {selected.data && <>
          <h2>{selected.data.name}</h2>
          <dl className="people-page__details">
            <dt>Organisation</dt><dd>{selected.data.organisation || 'Not recorded'}</dd>
            <dt>Role / relationship</dt><dd>{selected.data.role || 'Not recorded'}</dd>
            <dt>Email</dt><dd>{selected.data.emails.length ? selected.data.emails.map(email => <a key={email} href={`mailto:${email}`}>{email}</a>) : 'Not recorded'}</dd>
            <dt>Topics / threads</dt><dd>{selected.data.threads || 'Not recorded'}</dd>
            <dt>Notes</dt><dd>{selected.data.notes || 'No notes yet'}</dd>
            <dt>Contact group</dt><dd>{selected.data.contactGroup || 'Not recorded'}</dd>
            <dt>Emails sent</dt><dd>{selected.data.emailCount ?? 'Not recorded'}{selected.data.sourcePeriod && ` during ${selected.data.sourcePeriod}`}</dd>
            <dt>Source</dt><dd>{selected.data.source || 'Added manually'}</dd>
          </dl>
          <div className="people-page__actions">
            <button className="people-page__button" disabled={busy} onClick={() => { setEditing({ id: selected.data.id, input: selected.data }); }}>Edit person</button>
            <button className="people-page__button people-page__button--danger" disabled={busy} onClick={() => { void (async () => {
              if (!await confirmDialog(`Delete ${selected.data.name}? Existing mentions will show this person as unavailable.`, { title: 'Delete person', confirmLabel: 'Delete', tone: 'danger' })) return;
              await run(async () => { requireApiData(await api.deletePerson(selected.data.id)); setParams({}); setNotice('Person deleted.'); });
            })(); }}>Delete person</button>
          </div>
        </>}
      </section>}
    </div>
  </section>;
}

function PersonForm({ initial, busy, onSave, onCancel }: {
  initial: PersonInput; busy: boolean; onSave: (input: PersonInput) => void; onCancel: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(initial);
  const [emails, setEmails] = useState(initial.emails.join('\n'));
  return <form className="people-page__panel people-page__form" onSubmit={event => {
    event.preventDefault(); onSave({ ...draft, emails: emails.split(/[\n,;]+/).map(email => email.trim()).filter(Boolean) });
  }}>
    <h2>{'id' in initial ? 'Edit person' : 'Add person'}</h2>
    <label>Name<input required maxLength={200} value={draft.name} disabled={busy} onChange={event => { setDraft({ ...draft, name: event.target.value }); }} /></label>
    <label>Email addresses (one per line)<textarea rows={2} value={emails} disabled={busy} onChange={event => { setEmails(event.target.value); }} /></label>
    <label>Organisation<input maxLength={1000} value={draft.organisation} disabled={busy} onChange={event => { setDraft({ ...draft, organisation: event.target.value }); }} /></label>
    <label>Role / relationship<input maxLength={1000} value={draft.role} disabled={busy} onChange={event => { setDraft({ ...draft, role: event.target.value }); }} /></label>
    <label>Topics / threads<textarea rows={3} maxLength={10000} value={draft.threads} disabled={busy} onChange={event => { setDraft({ ...draft, threads: event.target.value }); }} /></label>
    <label>Notes<textarea rows={4} maxLength={10000} value={draft.notes} disabled={busy} onChange={event => { setDraft({ ...draft, notes: event.target.value }); }} /></label>
    <div className="people-page__actions">
      <button className="people-page__button people-page__button--primary" disabled={busy || !draft.name.trim()}>{busy ? 'Saving...' : 'Save person'}</button>
      <button type="button" className="people-page__button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
