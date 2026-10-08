import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { authSession } from '../services/authSession';
import { reauthenticate } from '../services/auth';

export const SessionExpiredDialog: React.FC<{ authenticate?: () => Promise<void> }> = ({ authenticate = reauthenticate }) => {
  const expired = useSyncExternalStore(authSession.subscribe, authSession.isExpired);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (expired && !dialog.current?.open) {
      setError('');
      dialog.current?.showModal();
      button.current?.focus();
    } else if (!expired) {
      dialog.current?.close();
    }
  }, [expired]);

  const renew = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await authenticate();
    } catch (err) {
      console.warn('[auth] Re-authentication failed.', err);
      setError('Sign-in was cancelled or could not complete. Please try again; allow pop-ups for Athena if your browser blocked it.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <dialog ref={dialog} className="kh-session-dialog" aria-labelledby="kh-session-title" aria-describedby="kh-session-description"
      onCancel={(event) => { event.preventDefault(); }}>
      <p className="kh-session-dialog__label">Athena</p>
      <h2 id="kh-session-title">Your sign-in has expired</h2>
      <p id="kh-session-description">Re-authenticate with Microsoft to continue. This page will stay open while you sign in.</p>
      {error !== '' && <p role="alert" className="kh-session-dialog__error">{error}</p>}
      <button ref={button} type="button" className="kh-session-dialog__button" disabled={busy} onClick={() => { void renew(); }}>
        {busy ? 'Signing in...' : 'Re-authenticate'}
      </button>
    </dialog>, document.body,
  );
};
