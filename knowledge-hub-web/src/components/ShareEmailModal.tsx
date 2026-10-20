import React, { useRef, useState } from 'react';
import { Modal } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { api } from '../services/api';
import { describeApiError } from '../services/apiError';
import { loadShareEmailStatus, SHARE_EMAIL_QUERY } from './ShareEmailSettings';
import type { ShareEmailContent, ShareEmailInput, ShareEmailResult } from '../types/shareEmail';
import './shareEmail.scss';

export const ShareEmailModal: React.FC<{ content: ShareEmailContent; onClose: () => void }> = ({ content, onClose }) => {
  const query = useQuery({ queryKey: SHARE_EMAIL_QUERY, queryFn: loadShareEmailStatus, staleTime: 0 });
  const [recipients, setRecipients] = useState('');
  const [subject, setSubject] = useState(content.title.slice(0, 200));
  const [message, setMessage] = useState(`I'd like to share ${content.title} with you.`);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ShareEmailResult | null>(null);
  const attempt = useRef<ShareEmailInput | null>(null);
  const [attempted, setAttempted] = useState(false);
  const addresses = recipients.split(/[;,\n]+/).map(s => s.trim()).filter(Boolean);
  const send = async () => {
    if (lock.current || result || !query.data?.configured || addresses.length === 0 || !subject.trim()) return;
    lock.current = true; setBusy(true); setError('');
    // Reuse the exact request on an explicit retry after an ambiguous network response.
    attempt.current ??= { requestId: crypto.randomUUID(), confirmed: true, recipients: addresses, subject, message,
      ...(content.url ? { url: content.url } : {}), ...(content.attachment ? { attachment: content.attachment } : {}) };
    setAttempted(true);
    try {
      const response = await api.sendShareEmail(attempt.current);
      if (!response.success) {
        if (response.error.code === 'VALIDATION_ERROR') { attempt.current = null; setAttempted(false); }
        throw new Error(response.error.message);
      }
      setResult(response.data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 422) { attempt.current = null; setAttempted(false); }
      setError(`${describeApiError(err)}${attempt.current ? ' Check SMTP2GO activity before composing a new copy.' : ''}`);
    }
    finally { lock.current = false; setBusy(false); }
  };
  const close = () => { if (!lock.current) onClose(); };
  return <Modal open className="share-email-modal" modalHeading="Share by email" size="sm"
    primaryButtonText={result ? 'Done' : busy ? 'Sending...' : attempted ? 'Check / retry same request' : 'Send email'}
    primaryButtonDisabled={busy || (!result && (!query.data?.configured || !subject.trim() || addresses.length === 0 || addresses.length > 20))}
    secondaryButtonText="Cancel" onRequestClose={close} onRequestSubmit={() => { if (result) close(); else void send(); }}>
    <div className="share-email">
      {query.isPending && <p role="status">Checking email settings...</p>}
      {query.isError && <p role="alert">{describeApiError(query.error)} <button type="button" className="connection-tokens__button" onClick={() => { void query.refetch(); }}>Retry settings</button></p>}
      {query.data && !query.data.configured && <p role="alert">Set up <Link to="/my-work?sync=1" onClick={close}>SMTP2GO in Sources / Integrations</Link> before sending.</p>}
      <p>From: Athena &lt;{query.data?.from ?? 'share@athena.themicrosoftcloudblog.com'}&gt;
        {query.data?.replyTo && <> · Reply-To: {query.data.replyTo}</>}</p>
      <label htmlFor="share-email-to">Recipients (up to 20, separated by commas)</label>
      <input id="share-email-to" value={recipients} disabled={busy || attempted} autoComplete="off"
        maxLength={5100} onChange={e => { setRecipients(e.target.value); }} />
      <p>Recipients are hidden from each other. Links do not grant access to private Mural boards or GitHub repositories.</p>
      <label htmlFor="share-email-subject">Subject</label>
      <input id="share-email-subject" value={subject} maxLength={200} disabled={busy || attempted} onChange={e => { setSubject(e.target.value); }} />
      <label htmlFor="share-email-message">Message</label>
      <textarea id="share-email-message" rows={5} value={message} maxLength={10000} disabled={busy || attempted} onChange={e => { setMessage(e.target.value); }} />
      <div className="share-email__content">
        <h3>Included content</h3>
        {content.url && <a href={content.url} target="_blank" rel="noreferrer">{content.url}</a>}
        {content.attachment && <p>Attachment: {content.attachment.filename} ({Math.ceil(new Blob([content.attachment.xml]).size / 1024)} KiB)</p>}
        {content.url?.includes('github.com/') && <p>This link shows the published GitHub version, which may differ from unsaved or unpublished Think edits.</p>}
      </div>
      {busy && <p role="status">Sending once through SMTP2GO. Do not close this window.</p>}
      {result && <p role={result.rejected ? 'alert' : 'status'}>
        SMTP2GO accepted {result.accepted} recipient(s){result.rejected ? `; rejected ${result.rejected}. Check SMTP2GO activity before resending.` : '. This confirms submission, not inbox delivery.'}
      </p>}
      {error && <p className="share-email__error" role="alert">{error}</p>}
    </div>
  </Modal>;
};
