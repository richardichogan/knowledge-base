import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { SettingsLink } from '../navigation/SettingsLink';
import { isAxiosError } from 'axios';
import { api } from '../services/api';
import { describeApiError } from '../services/apiError';
import { loadShareEmailStatus, SHARE_EMAIL_QUERY } from './ShareEmailSettings';
import type { ShareEmailContent, ShareEmailInput, ShareEmailResult } from '../types/shareEmail';
import './shareEmail.scss';
import { requireApiData } from '../services/apiError';
import { recipientMention, insertRecipient } from '../people/contactText';
import { ContactCapture } from './ContactCapture';
import { renderMarkdown } from '../utils/markdown';

export const ShareEmailModal: React.FC<{ content: ShareEmailContent; onClose: () => void }> = ({ content, onClose }) => {
  const query = useQuery({ queryKey: SHARE_EMAIL_QUERY, queryFn: loadShareEmailStatus, staleTime: 0 });
  const [recipients, setRecipients] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [contactIndex, setContactIndex] = useState(0);
  const [dismissContacts, setDismissContacts] = useState(false);
  const [captureContacts, setCaptureContacts] = useState(false);
  const mention = recipientMention(recipients);
  useEffect(() => {
    const timer = window.setTimeout(() => { setContactSearch(mention?.query ?? ''); setContactIndex(0); }, 200);
    return () => window.clearTimeout(timer);
  }, [mention?.query]);
  const contacts = useQuery({ queryKey: ['share-email-contacts', contactSearch],
    queryFn: async () => requireApiData(await api.getPeople(contactSearch)), enabled: mention !== null && !dismissContacts });
  const suggestions = (contacts.data ?? []).flatMap(person => person.emails.map(email => ({ name: person.name, email })))
    .filter(person => `${person.name} ${person.email}`.toLowerCase().includes((mention?.query ?? '').toLowerCase())).slice(0, 8);
  const recipientInput = useRef<HTMLInputElement>(null);
  const chooseContact = (email: string): void => {
    if (lock.current || attempt.current) return;
    setRecipients(current => insertRecipient(current, email));
    setDismissContacts(false);
    recipientInput.current?.focus();
  };
  const [subject, setSubject] = useState(content.title.slice(0, 200));
  const [message, setMessage] = useState(`I'd like to share ${content.title} with you.`);
  const muralBoard = content.url?.startsWith('https://app.mural.co/') ?? false;
  const [muralAccess, setMuralAccess] = useState<'none' | 'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ShareEmailResult | null>(null);
  const attempt = useRef<ShareEmailInput | null>(null);
  const [attempted, setAttempted] = useState(false);
  const addresses = recipients.split(/[;,\n]+/).map(s => s.trim()).filter(Boolean);
  const unresolvedContact = mention !== null;
  const send = async () => {
    if (lock.current || result || !query.data?.configured || addresses.length === 0 || !subject.trim() || unresolvedContact) return;
    lock.current = true; setBusy(true); setError('');
    // Reuse the exact request on an explicit retry after an ambiguous network response.
    attempt.current ??= { requestId: crypto.randomUUID(), confirmed: true, recipients: addresses, subject, message,
      ...(muralBoard && muralAccess !== 'none' ? { muralAccess } : {}),
      ...(content.note ? { note: content.note } : {}),
      ...(content.url ? { url: content.url } : {}), ...(content.attachment ? { attachment: content.attachment } : {}) };
    setAttempted(true);
    try {
      const response = await api.sendShareEmail(attempt.current);
      if (!response.success) {
        if (response.error.code === 'VALIDATION_ERROR') { attempt.current = null; setAttempted(false); }
        throw new Error(response.error.message);
      }
      if (response.data.rejected === 0) onClose();
      else setResult(response.data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 422) { attempt.current = null; setAttempted(false); }
      setError(`${describeApiError(err)}${attempt.current ? ' Check SMTP2GO activity and any Mural invitations before composing a new copy.' : ''}`);
    }
    finally { lock.current = false; setBusy(false); }
  };
  const close = () => { if (!lock.current) onClose(); };
  return <Modal open className="share-email-modal" modalHeading="Share by email" size="sm"
    primaryButtonText={result ? 'Done' : busy ? 'Sharing...' : attempted ? 'Check / retry same request' : muralBoard && muralAccess !== 'none' ? 'Invite & send email' : 'Send email'}
    primaryButtonDisabled={busy || (!result && (!query.data?.configured || !subject.trim() || unresolvedContact || addresses.length === 0 || addresses.length > 20))}
    secondaryButtonText="Cancel" onRequestClose={close} onRequestSubmit={() => { if (result) close(); else void send(); }}>
    <div className="share-email">
      {query.isPending && <p role="status">Checking email settings...</p>}
      {query.isError && <p role="alert">{describeApiError(query.error)} <button type="button" className="connection-tokens__button" onClick={() => { void query.refetch(); }}>Retry settings</button></p>}
      {query.data && !query.data.configured && <p role="alert">Set up <SettingsLink to="/my-work?sync=1" onClick={close}>SMTP2GO in Connections and sync</SettingsLink> before sending.</p>}
      <p>From: Athena &lt;{query.data?.from ?? 'share@athena.themicrosoftcloudblog.com'}&gt;
        {query.data?.replyTo && <> · Reply-To: {query.data.replyTo}</>}</p>
      <label htmlFor="share-email-to">Recipients (up to 20, separated by commas)</label>
      <input id="share-email-to" ref={recipientInput} value={recipients} disabled={busy || attempted} autoComplete="off"
        role="combobox" aria-autocomplete="list" aria-expanded={!!mention && !dismissContacts}
        aria-controls="share-contact-options" aria-activedescendant={mention && !dismissContacts && suggestions[contactIndex] ? `share-contact-${contactIndex}` : undefined}
        placeholder="Email addresses or @contact"
        maxLength={5100} onChange={e => { setRecipients(e.target.value); setDismissContacts(false); }}
        onKeyDown={event => {
          if (!mention || dismissContacts) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissContacts(true); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setContactIndex(current => suggestions.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length : 0);
          }
          if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation();
            const suggestion = suggestions[contactIndex];
            if (suggestion) chooseContact(suggestion.email);
          }
        }} />
      {mention && !dismissContacts && <div className="share-email__contacts" id="share-contact-options" role="listbox" aria-label="Matching contacts">
        {contacts.isPending && <p role="status">Finding contacts...</p>}
        {contacts.error && <p role="alert">{describeApiError(contacts.error)} <button type="button" onClick={() => { void contacts.refetch(); }}>Retry</button></p>}
        {suggestions.map((person, index) => <button id={`share-contact-${index}`} type="button" role="option"
          aria-selected={index === contactIndex} key={person.email} disabled={busy || attempted}
          onClick={() => chooseContact(person.email)}>{person.name} &lt;{person.email}&gt;</button>)}
        {!contacts.isPending && !contacts.error && !suggestions.length && <p>No contacts with email addresses found. Add one below.</p>}
      </div>}
      <button type="button" className="share-email__contact-toggle" disabled={busy || attempted}
        aria-expanded={captureContacts} onClick={() => setCaptureContacts(value => !value)}>Identify contacts from text</button>
      {captureContacts && <ContactCapture text={message} onSaved={person => {
        const email = person.emails[0]; if (email) chooseContact(email);
      }} />}
      <p>Recipients are hidden from each other. {content.note ? 'The full note text will be included in the email. Review the snapshot below before sending.' : 'Links do not grant access to private Mural boards or GitHub repositories.'}</p>
      {muralBoard && <>
        <label htmlFor="share-mural-access">Mural board access</label>
        <select id="share-mural-access" value={muralAccess} disabled={busy || attempted}
          onChange={e => { const value = e.target.value; if (value === 'none' || value === 'view' || value === 'edit') setMuralAccess(value); }}>
          <option value="view">Invite recipients to view</option>
          <option value="edit">Invite recipients to edit</option>
          <option value="none">Send link only (do not change access)</option>
        </select>
        <p>{muralAccess === 'none' ? 'Recipients must already have board access.' : 'Mural sends a separate invitation before Athena sends this email. Recipients may need to accept it. This grants access to the whole board, not just this diagram. Board collaborators may see each other; workspace policies still apply. The board will not be made public.'}</p>
      </>}
      <label htmlFor="share-email-subject">Subject</label>
      <input id="share-email-subject" value={subject} maxLength={200} disabled={busy || attempted} onChange={e => { setSubject(e.target.value); }} />
      <label htmlFor="share-email-message">Message</label>
      <textarea id="share-email-message" rows={5} value={message} maxLength={10000} disabled={busy || attempted} onChange={e => { setMessage(e.target.value); }} />
      <div className="share-email__content">
        <h3>Included content</h3>
        {content.note && <>
          <p>{content.note.title} · Formatted note text, captured when you opened Share.</p>
          <div className="share-email__note-preview" aria-label="Note text preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(content.note.markdown) }} />
        </>}
        {content.url && <a href={content.url} target="_blank" rel="noreferrer">{content.url}</a>}
        {content.attachment && <p>Attachment: {content.attachment.filename} ({Math.ceil(new Blob([content.attachment.xml]).size / 1024)} KiB)</p>}
        {content.url?.includes('github.com/') && <p>This link shows the published GitHub version, which may differ from unsaved or unpublished Think edits.</p>}
      </div>
      {busy && <p role="status">{muralBoard && muralAccess !== 'none' ? 'Inviting recipients and sending email...' : 'Sending email...'} Do not close this window.</p>}
      {result?.muralInvited !== undefined && <p role="status">Mural confirmed {result.muralInvited} invitation(s). This is not confirmation that recipients have accepted or opened the board.</p>}
      {result && <p role={result.rejected ? 'alert' : 'status'}>
        {result.rejected
          ? `Email sent to ${result.accepted} recipient(s); ${result.rejected} rejected. Check SMTP2GO activity before resending.`
          : 'Email sent.'}
      </p>}
      {error && <p className="share-email__error" role="alert">{error}</p>}
    </div>
  </Modal>;
};
