import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Information } from '@carbon/icons-react';
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
    <dialog ref={dialog} className="kh-dialog kh-dialog--info" aria-labelledby="kh-session-title" aria-describedby="kh-session-description"
      onCancel={(event) => { event.preventDefault(); }}>
      <header className="kh-dialog__header">
        <Information size={24} className="kh-dialog__icon" />
        <div className="kh-dialog__heading">
          <span className="kh-dialog__label">Athena</span>
          <h2 id="kh-session-title">Your sign-in has expired</h2>
        </div>
      </header>
      <div className="kh-dialog__body">
        <p id="kh-session-description" className="kh-dialog__message">Re-authenticate with Microsoft in a popup to continue. Athena will stay open with your unsaved work intact.</p>
        {error !== '' && <p role="alert" className="kh-dialog__error">{error}</p>}
      </div>
      <footer className="kh-dialog__actions">
        <button ref={button} type="button" className="kh-dialog__button kh-dialog__button--primary" disabled={busy} onClick={() => { void renew(); }}>
          {busy ? 'Signing in...' : 'Re-authenticate'}
        </button>
      </footer>
    </dialog>, document.body,
  );
};
