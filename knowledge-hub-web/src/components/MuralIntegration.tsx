import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type MuralStatus } from '../services/api';
import { describeApiError } from '../services/apiError';
import './connectionTokens.scss';
import './muralIntegration.scss';

export const MURAL_QUERY = ['mural-integration'] as const;
export async function loadMuralStatus(): Promise<MuralStatus> {
  const response = await api.getMuralStatus();
  if (!response.success) throw new Error(response.error.message);
  return response.data;
}

export const MuralIntegration: React.FC = () => {
  const query = useQuery({ queryKey: MURAL_QUERY, queryFn: loadMuralStatus, staleTime: 0 });
  const cache = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [boardUrl, setBoardUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (err) { setError(describeApiError(err)); }
    finally { setBusy(false); }
  }
  const status = query.data;
  return <section className="connection-tokens mural-integration" aria-labelledby="mural-integration-title">
    <h3 id="mural-integration-title">Mural</h3>
    <p className="connection-tokens__intro">Send diagrams to Mural as a complete image, including connectors, icons and selected annotations.
      Shapes are not individually editable in Mural. Nothing is exported automatically.</p>
    {query.isPending && <p className="connection-tokens__detail" role="status">Loading Mural connection...</p>}
    {query.isError && <div className="connection-tokens__error" role="alert">
      <p>{describeApiError(query.error)}</p>
      <button className="connection-tokens__button" type="button" onClick={() => { void query.refetch(); }}>Retry</button>
    </div>}
    {status && <article className="connection-tokens__card">
      <div className="connection-tokens__heading">
        <h4>Diagram export</h4>
        <span className={`connection-tokens__status${status.connected ? ' connection-tokens__status--configured' : ''}`}>
          {status.connected ? 'Authorised' : status.configured ? 'Credentials saved - connect to authorise' : 'Not configured'}
        </span>
      </div>
      <p className="connection-tokens__detail">Register this exact redirect URL in Mural: <span className="mural-integration__url">{status.redirectUrl}</span></p>
      {!editing && <p className="connection-tokens__detail">{status.boardUrl ? <>Default board: <a href={status.boardUrl} target="_blank" rel="noreferrer">Open in Mural</a></> : 'Choose a test board during setup.'}</p>}
      {editing ? <form className="connection-tokens__form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const response = await api.saveMuralConfig({ clientId, secret, boardUrl });
          if (!response.success) throw new Error(response.error.message);
          setSecret(''); setEditing(false); cache.setQueryData(MURAL_QUERY, response.data);
          setMessage('Settings saved. Connect to Mural to authorise export.');
        });
      }}>
        <label htmlFor="mural-client-id">Client ID</label>
        <input id="mural-client-id" value={clientId} required maxLength={36} disabled={busy} autoComplete="off"
          onChange={event => { setClientId(event.target.value); }} />
        <label htmlFor="mural-secret">Client secret{status.configured ? ' (leave blank to keep the saved secret)' : ''}</label>
        <input id="mural-secret" type="password" value={secret} required={!status.configured} disabled={busy} autoComplete="new-password"
          spellCheck={false} maxLength={8192} onChange={event => { setSecret(event.target.value); }} />
        <label htmlFor="mural-board">Default board URL</label>
        <input id="mural-board" type="url" value={boardUrl} required maxLength={2048} disabled={busy} autoComplete="off"
          placeholder="https://app.mural.co/t/.../m/..." onChange={event => { setBoardUrl(event.target.value); }} />
        <p className="connection-tokens__detail">Enable murals:read and murals:write in your Mural app. Credentials and OAuth tokens are encrypted on the server and never displayed.</p>
        <div className="connection-tokens__actions">
          <button type="submit" className="connection-tokens__button connection-tokens__button--primary" disabled={busy}>{busy ? 'Saving...' : 'Save settings'}</button>
          <button type="button" className="connection-tokens__button" disabled={busy} onClick={() => { setEditing(false); setSecret(''); }}>Cancel</button>
        </div>
      </form> : <div className="connection-tokens__actions">
        <button type="button" className="connection-tokens__button" disabled={busy} onClick={() => {
          setClientId(status.clientId); setBoardUrl(status.boardUrl); setSecret(''); setEditing(true); setError(''); setMessage('');
        }}>{status.configured ? 'Edit settings' : 'Set up Mural'}</button>
        {status.configured && <button type="button" className="connection-tokens__button connection-tokens__button--primary" disabled={busy} onClick={() => {
          void run(async () => {
            const response = await api.connectMural();
            if (!response.success) throw new Error(response.error.message);
            window.location.assign(response.data.url);
          });
        }}>{busy ? 'Working...' : status.connected ? 'Reconnect to Mural' : 'Connect to Mural'}</button>}
        {status.connected && <button type="button" className="connection-tokens__button" disabled={busy} onClick={() => {
          void run(async () => {
            const response = await api.disconnectMural();
            if (!response.success) throw new Error(response.error.message);
            await query.refetch(); setMessage('Disconnected. Saved app settings remain; existing Mural exports are unchanged.');
          });
        }}>Disconnect</button>}
        <a href="https://app.mural.co/me/apps" target="_blank" rel="noreferrer">Mural app settings</a>
      </div>}
      {message && <p className="connection-tokens__message" role="status">{message}</p>}
      {error && <p className="connection-tokens__error" role="alert">{error}</p>}
    </article>}
  </section>;
};

// Capture and scrub OAuth parameters before MSAL or third-party links can see them.
const callbackParams = typeof window !== 'undefined' && window.location.pathname === '/integrations/mural/callback'
  ? new URLSearchParams(window.location.search) : null;
if (callbackParams) window.history.replaceState(window.history.state, '', window.location.pathname);
let completion: Promise<void> | undefined;
export const MuralCallback: React.FC = () => {
  const [state, setState] = useState<'pending' | 'done' | 'error'>('pending');
  const [error, setError] = useState('');
  const cache = useQueryClient();
  useEffect(() => {
    let active = true;
    completion ??= (async () => {
      if (callbackParams?.has('error')) throw new Error('Mural authorisation was cancelled or rejected. Return to integrations and connect again.');
      const code = callbackParams?.get('code'), oauthState = callbackParams?.get('state');
      if (!code || !oauthState) throw new Error('Missing sign-in details. Return to integrations and connect again.');
      const response = await api.finishMuralAuth({ code, state: oauthState });
      if (!response.success) throw new Error(response.error.message);
    })();
    void completion.then(() => {
      void cache.invalidateQueries({ queryKey: MURAL_QUERY });
      if (active) setState('done');
    }).catch(err => { if (active) { setError(describeApiError(err)); setState('error'); } });
    return () => { active = false; };
  }, [cache]);
  return <main className="connection-tokens mural-integration mural-integration--callback">
    <h1>Mural connection</h1>
    {state === 'pending' && <p className="connection-tokens__detail" role="status">Completing secure sign-in...</p>}
    {state === 'done' && <p className="connection-tokens__message" role="status">Mural authorised. Open a Think diagram and choose Export, then Mural image, to send it to your board.</p>}
    {state === 'error' && <p className="connection-tokens__error" role="alert">{error}</p>}
    <div className="connection-tokens__actions"><Link to="/my-work?sync=1">Return to Sources / Integrations</Link></div>
  </main>;
};
