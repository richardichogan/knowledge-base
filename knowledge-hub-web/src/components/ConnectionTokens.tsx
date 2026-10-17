import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ConnectionCredential } from '../services/api';
import { describeApiError } from '../services/apiError';
import './connectionTokens.scss';

const TokenConnection: React.FC<{ connection: ConnectionCredential; onSaved: () => void }> = ({ connection, onSaved }) => {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputId = `connection-token-${connection.id}`;

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.updateConnectionCredential(connection.id, token);
      if (!response.success) throw new Error(response.error.message);
      setToken('');
      setEditing(false);
      setMessage(response.data.verified
        ? 'Token verified and saved. New requests use it automatically; existing source errors clear after a successful sync.'
        : 'Credential saved. Access has not been verified; the next connection request will use it.');
      onSaved();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="connection-tokens__card">
      <div className="connection-tokens__heading">
        <h4>{connection.name}</h4>
        <span className={`connection-tokens__status${connection.configured ? ' connection-tokens__status--configured' : ''}`}>
          {connection.usingFallback !== null ? `Using ${connection.usingFallback}` : connection.configured ? 'Credential configured' : 'Not configured'}
        </span>
      </div>
      <p className="connection-tokens__detail">{connection.detail}</p>
      {connection.updatedAt !== null && <p className="connection-tokens__updated">Updated {new Date(connection.updatedAt).toLocaleString()}</p>}
      {!editing ? (
        <button type="button" className="connection-tokens__button" onClick={() => {
          setEditing(true); setError(null); setMessage(null);
        }}>
          {connection.configured && connection.usingFallback === null ? 'Update token / key' : 'Add token / key'}
        </button>
      ) : (
        <form className="connection-tokens__form" onSubmit={(event) => { void save(event); }}>
          <label htmlFor={inputId}>New token, API key or app password</label>
          <input id={inputId} type="password" value={token} autoComplete="new-password" spellCheck={false}
            autoCapitalize="none" maxLength={8192} required disabled={busy}
            aria-describedby={error === null ? undefined : `${inputId}-error`}
            onChange={(event) => { setToken(event.target.value); }} />
          <div className="connection-tokens__actions">
            <button type="submit" className="connection-tokens__button connection-tokens__button--primary" disabled={busy || token.trim() === ''}>
              {busy ? 'Saving...' : 'Save credential'}
            </button>
            <button type="button" className="connection-tokens__button" disabled={busy} onClick={() => {
              setToken(''); setEditing(false); setError(null);
            }}>Cancel</button>
            {connection.helpUrl !== undefined && <a href={connection.helpUrl} target="_blank" rel="noreferrer">Create a new credential</a>}
          </div>
        </form>
      )}
      {error !== null && <p id={`${inputId}-error`} className="connection-tokens__error" role="alert">{error}</p>}
      {message !== null && <p className="connection-tokens__message" role="status">{message}</p>}
    </article>
  );
};

export const ConnectionTokens: React.FC = () => {
  const query = useQuery({
    queryKey: ['connection-credentials'],
    queryFn: async () => {
      const response = await api.getConnectionCredentials();
      if (!response.success) throw new Error(response.error.message);
      return response.data;
    },
    staleTime: 30_000,
  });
  return (
    <section className="connection-tokens" aria-labelledby="connection-tokens-title">
      <h3 id="connection-tokens-title">Connection tokens and API keys</h3>
      <p className="connection-tokens__intro">Replace credentials here without editing server settings. Saved values are encrypted and never shown again.
        Microsoft connections use their existing sign-in / reconnect flow, not pasted access tokens.</p>
      {query.isPending && <p className="connection-tokens__intro" role="status">Loading token connections...</p>}
      {query.isError && <div className="connection-tokens__error" role="alert">
        <p>{describeApiError(query.error)}</p>
        <button type="button" className="connection-tokens__button" onClick={() => { void query.refetch(); }}>Retry</button>
      </div>}
      <div className="connection-tokens__list">
        {query.data?.map((connection) => (
          <TokenConnection key={connection.id} connection={connection} onSaved={() => { void query.refetch(); }} />
        ))}
      </div>
    </section>
  );
};
