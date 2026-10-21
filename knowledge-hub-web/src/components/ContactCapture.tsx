import React, { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { requireApiData, describeApiError } from '../services/apiError';
import { contactsFromText } from '../people/contactText';
import type { Person, PersonInput } from '../types/people';
import './shareEmail.scss';

export function ContactCapture({ text, onSaved }: { text: string; onSaved?: (person: Person) => void }): React.JSX.Element {
  const qc = useQueryClient();
  const [source, setSource] = useState(text.slice(0, 10_000));
  const [drafts, setDrafts] = useState<PersonInput[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const edit = (index: number, patch: Partial<PersonInput>): void => {
    setDrafts(current => current.map((draft, i) => i === index ? { ...draft, ...patch } : draft));
  };
  const save = async (draft: PersonInput, index: number): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const person = requireApiData(await api.savePerson(draft));
      setSaved(current => [...current, index]);
      await qc.invalidateQueries({ queryKey: ['people'] });
      await qc.invalidateQueries({ queryKey: ['share-email-contacts'] });
      onSaved?.(person);
    } catch (err) { setError(describeApiError(err)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="contact-capture" aria-label="Identify contacts from text"
    onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation(); }}>
    <p>Paste a signature or select text from a note. Review each contact before saving. Names and relationships are never guessed.</p>
    <label>Source text<textarea rows={4} value={source} maxLength={10_000} disabled={busy}
      onChange={event => { setSource(event.target.value); }} /></label>
    <button type="button" disabled={busy || !source.trim()} onClick={() => {
      try { setDrafts(contactsFromText(source)); setSaved([]); setError(''); }
      catch (err) { setError(describeApiError(err)); }
    }}>Identify contacts</button>
    {drafts.map((draft, index) => <div className="contact-capture__draft" key={index}>
      <label>Name<input value={draft.name} maxLength={200} disabled={busy || saved.includes(index)}
        onChange={event => edit(index, { name: event.target.value })} /></label>
      <label>Email<input type="email" value={draft.emails[0] ?? ''} maxLength={254} disabled={busy || saved.includes(index)}
        onChange={event => edit(index, { emails: event.target.value.trim() ? [event.target.value.trim()] : [] })} /></label>
      <label>Organisation<input value={draft.organisation} maxLength={1000} disabled={busy || saved.includes(index)}
        onChange={event => edit(index, { organisation: event.target.value })} /></label>
      <button type="button" disabled={busy || saved.includes(index) || !draft.name.trim()} onClick={() => { void save(draft, index); }}>
        {saved.includes(index) ? 'Contact saved' : busy ? 'Saving...' : 'Save contact'}</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
    {saved.length > 0 && <p role="status">{saved.length} contact(s) saved to People.</p>}
  </section>;
}
