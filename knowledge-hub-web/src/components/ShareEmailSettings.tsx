import React, { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { describeApiError } from '../services/apiError';
import './connectionTokens.scss';

export const SHARE_EMAIL_QUERY = ['share-email-settings'] as const;
export async function loadShareEmailStatus() {
  const response = await api.getShareEmailStatus();
  if (!response.success) throw new Error(response.error.message);
  return response.data;
}

export const ShareEmailSettings: React.FC = () => {
  const query = useQuery({ queryKey: SHARE_EMAIL_QUERY, queryFn: loadShareEmailStatus, staleTime: 0 });
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const status = query.data;
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (err) { setError(describeApiError(err)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="connection-tokens" aria-labelledby="share-email-title">
    <h3 id="share-email-title">SMTP2GO sharing</h3>
    <p className="connection-tokens__intro">Send a Mural or GitHub note link, or attach a draw.io file. You choose the recipients and confirm each email. Nothing is sent automatically.</p>
    {query.isPending && <p className="connection-tokens__detail" role="status">Loading email settings...</p>}
    {query.isError && <div className="connection-tokens__error" role="alert">
      <p>{describeApiError(query.error)}</p>
      <button type="button" className="connection-tokens__button" onClick={() => { void query.refetch(); }}>Retry</button>
    </div>}
    {status && <div className="connection-tokens__card">
      <div className="connection-tokens__heading"><h4>Athena &lt;{status.from}&gt;</h4>
        <span className={`connection-tokens__status${status.configured ? ' connection-tokens__status--configured' : ''}`}>
          {status.configured ? 'Settings saved' : 'Not configured'}
        </span>
      </div>
      <p className="connection-tokens__detail">Uses {status.host}:{status.port} with required STARTTLS. Verify athena.themicrosoftcloudblog.com in SMTP2GO; no sender mailbox is needed. Optional Reply-To directs replies to an existing mailbox.</p>
      {editing ? <form className="connection-tokens__form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const response = await api.saveShareEmailConfig({ username, password, replyTo });
          if (!response.success) throw new Error(response.error.message);
          setPassword(''); setEditing(false); cache.setQueryData(SHARE_EMAIL_QUERY, response.data);
          setMessage('Settings saved. Check the connection to verify SMTP authentication; domain verification is managed in SMTP2GO.');
        });
      }}>
        <label htmlFor="share-smtp-user">SMTP username</label>
        <input id="share-smtp-user" autoComplete="off" value={username} required maxLength={254} disabled={busy} onChange={e => { setUsername(e.target.value); }} />
        <label htmlFor="share-smtp-password">SMTP password{status.configured ? ' (leave blank to keep saved)' : ''}</label>
        <input id="share-smtp-password" type="password" autoComplete="new-password" spellCheck={false} value={password} required={!status.configured}
          maxLength={8192} disabled={busy} onChange={e => { setPassword(e.target.value); }} />
        <label htmlFor="share-reply-to">Reply-To (optional)</label>
        <input id="share-reply-to" type="email" value={replyTo} maxLength={254} disabled={busy} onChange={e => { setReplyTo(e.target.value); }} />
        <p className="connection-tokens__detail">The password is encrypted on the server and never returned to the browser. Saving does not send an email.</p>
        <div className="connection-tokens__actions">
          <button type="submit" className="connection-tokens__button connection-tokens__button--primary" disabled={busy}>{busy ? 'Saving...' : 'Save settings'}</button>
          <button type="button" className="connection-tokens__button" disabled={busy} onClick={() => { setPassword(''); setEditing(false); }}>Cancel</button>
        </div>
      </form> : <div className="connection-tokens__actions">
        <button type="button" className="connection-tokens__button" disabled={busy} onClick={() => {
          setUsername(status.username); setReplyTo(status.replyTo); setPassword(''); setEditing(true); setError(''); setMessage('');
        }}>{status.configured ? 'Edit email settings' : 'Set up SMTP2GO'}</button>
        {status.configured && <button type="button" className="connection-tokens__button" disabled={busy} onClick={() => {
          void run(async () => {
            const response = await api.verifyShareEmailConfig();
            if (!response.success) throw new Error(response.error.message);
            setMessage('SMTP authentication verified. No email was sent; this does not verify the sender domain or delivery.');
          });
        }}>{busy ? 'Checking...' : 'Check connection (no email)'}</button>}
        <a href="https://app.smtp2go.com" target="_blank" rel="noreferrer">SMTP2GO settings</a>
      </div>}
      {message && <p className="connection-tokens__message" role="status">{message}</p>}
      {error && <p className="connection-tokens__error" role="alert">{error}</p>}
    </div>}
  </section>;
};
