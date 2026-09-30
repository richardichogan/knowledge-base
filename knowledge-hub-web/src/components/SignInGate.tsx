/**
 * SignInGate.tsx — requires a Microsoft (IBM Alliance tenant) sign-in before
 * the app renders. Passes straight through when sign-in isn't configured
 * (local dev).
 */
import React, { useEffect, useState } from 'react';
import { AUTH_ENABLED, initAuth, signIn } from '../services/auth';

type State = 'checking' | 'signed-in' | 'signed-out' | 'error';

interface Props { children: React.ReactNode; }

export const SignInGate: React.FC<Props> = ({ children }) => {
  const [state, setState] = useState<State>(AUTH_ENABLED ? 'checking' : 'signed-in');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!AUTH_ENABLED) return;
    initAuth()
      .then((account) => { setState(account === null ? 'signed-out' : 'signed-in'); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); setState('error'); });
  }, []);

  if (state === 'signed-in') return <>{children}</>;

  return (
    <div className="pw-gate">
      <div className="pw-gate__form">
        <p className="pw-gate__label">Athena</p>
        {state === 'checking' && <p className="pw-gate__hint">Signing in…</p>}
        {state === 'error' && <p className="pw-gate__error">Sign-in failed: {error}</p>}
        {state !== 'checking' && (
          <button className="kh-btn-accent pw-gate__btn" type="button" onClick={() => { void signIn(); }}>
            Sign in with Microsoft
          </button>
        )}
      </div>
    </div>
  );
};
