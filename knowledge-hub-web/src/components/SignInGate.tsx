/**
 * SignInGate.tsx — requires a Microsoft (IBM Alliance tenant) sign-in before
 * the app renders. Passes straight through when sign-in isn't configured
 * (local dev).
 */
import React, { useEffect, useState } from 'react';
import { AUTH_ENABLED, initAuth, signIn } from '../services/auth';
import { SessionExpiredDialog } from './SessionExpiredDialog';

type State = 'checking' | 'signed-in' | 'signed-out' | 'error';

interface Props { children: React.ReactNode; }

export const SignInGate: React.FC<Props> = ({ children }) => {
  const [state, setState] = useState<State>(AUTH_ENABLED ? 'checking' : 'signed-in');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!AUTH_ENABLED) return;
    initAuth()
      .then((account) => {
        if (account !== null) {
          setState('signed-in');
          return;
        }
        setState('signed-out');
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); setState('error'); });
  }, []);

  if (state === 'signed-in') return <>{children}<SessionExpiredDialog /></>;

  return (
    <div className="pw-gate">
      <div className="pw-gate__form">
        <p className="pw-gate__label">Athena</p>
        {state === 'checking' && <p className="pw-gate__hint">Checking sign-in...</p>}
        {state === 'signed-out' && <p className="pw-gate__hint">Sign in with Microsoft to access Athena.</p>}
        {state === 'error' && <p className="pw-gate__error">Sign-in failed: {error}</p>}
        {state !== 'checking' && (
          <button className="kh-btn-accent pw-gate__btn" type="button" onClick={() => {
            setState('checking');
            void signIn().catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
              setState('error');
            });
          }}>
            Sign in with Microsoft
          </button>
        )}
      </div>
    </div>
  );
};
