import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Theme } from '@carbon/react';
import { PeoplePage } from '../src/pages/PeoplePage';
import { PeopleMentionSuggestions } from '../src/people/PeopleMentionSuggestions';
import { api } from '../src/services/api';
import { EMPTY_PERSON, type Person } from '../src/types/people';
import { NoteEditor } from '../src/notes/NoteEditor';
import { AppDialogHost } from '../src/components/AppDialog';
import { entityLinkHref } from '../src/notes/entityLinks';
import type { ApiResponse } from '../src/types/apiResponse';
import './note-draft-identity';
import '../src/styles/global.scss';

const success = <T,>(data: T): ApiResponse<T> => ({ success: true, data });
let contacts: Person[] = [{ ...EMPTY_PERSON, id: '00000000-0000-4000-8000-000000000001', name: 'Example Contact',
  emails: ['example@example.com'], organisation: 'Example Org', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
api.getPeople = async query => success(contacts.filter(person => JSON.stringify(person).toLowerCase().includes((query ?? '').toLowerCase())));
api.getPerson = async id => { const person = contacts.find(item => item.id === id); if (!person) throw new Error('Person not found'); return success(person); };
api.savePerson = async (input, id) => {
  const person = { ...input, id: id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  contacts = [...contacts.filter(item => item.id !== person.id), person]; return success(person);
};
api.deletePerson = async id => { contacts = contacts.filter(person => person.id !== id); return success({ deleted: true }); };
api.importPeople = async people => {
  let created = 0; let updated = 0;
  for (const person of people) {
    const existing = contacts.find(item => item.emails.some(email => person.emails.includes(email)));
    await api.savePerson(person, existing?.id);
    if (existing) updated++; else created++;
  }
  return success({ created, updated });
};
api.getLinkTargets = async (query = '', type, id) => success(type && type !== 'person' ? [] : contacts
  .filter(person => (!id || person.id === id) && JSON.stringify(person).toLowerCase().includes(query.toLowerCase()))
  .map(person => ({ type: 'person', id: person.id, title: person.name, href: entityLinkHref('person', person.id) })));
api.getLinkPreview = async () => success({ summary: 'Example contact context', details: [{ label: 'Organisation', value: 'Example Org' }] });
api.getTaxonomy = async () => success([]);
api.getNoteTags = async () => success([]);
api.getProjects = async () => success([]);
api.getNoteGitHub = async () => success(null);

function Composer(): React.ReactElement {
  const [input, setInput] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  return <div className="people-page">
    <label>Chat mention fixture</label><div className="ai-input-field">
      <PeopleMentionSuggestions input={input} textarea={ref} onChange={setInput} />
      <textarea id="people-chat" className="ai-input-textarea" ref={ref} value={input} onChange={event => { setInput(event.target.value); }} />
    </div>
    <output id="people-chat-value">{input}</output>
  </div>;
}
const notes = new URLSearchParams(location.search).has('notes');
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <Theme theme="g100"><MemoryRouter><AppDialogHost />
    {notes ? <NoteEditor doc={{ id: 'people-test-note', title: 'People mentions', contentType: 'note',
      contentJson: JSON.stringify([{ type: 'paragraph', content: 'Meet ' }]), createdAt: '', updatedAt: '' }} onSaved={() => {}} />
      : <><PeoplePage /><Composer /></>}
  </MemoryRouter></Theme>
</QueryClientProvider>);
