/**
 * SignInGate.tsx — requires a Microsoft (IBM Alliance tenant) sign-in before
 * the app renders. Passes straight through when sign-in isn't configured
 * (local dev).
 */
import React, { useEffect, useState } from 'react';
import { AUTH_ENABLED, AUTH_REQUIRED_EVENT, initAuth, signIn, renewSignIn } from '../services/auth';

type State = 'checking' | 'signed-in' | 'signed-out' | 'error';

const AUTO_KEY = 'kh_auto_signin_attempted';
function autoAttempted(): boolean { try { return window.sessionStorage.getItem(AUTO_KEY) === '1'; } catch { return true; } }
function markAutoAttempt(): void { try { window.sessionStorage.setItem(AUTO_KEY, '1'); } catch { /* storage unavailable */ } }
function clearAutoAttempt(): void { try { window.sessionStorage.removeItem(AUTO_KEY); } catch { /* storage unavailable */ } }

interface Props { children: React.ReactNode; }

export const SignInGate: React.FC<Props> = ({ children }) => {
  const [state, setState] = useState<State>(AUTH_ENABLED ? 'checking' : 'signed-in');
  const [error, setError] = useState('');
  const [renewalRequired, setRenewalRequired] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [renewalError, setRenewalError] = useState('');

  useEffect(() => {
    const onRequired = (): void => { setRenewalRequired(true); };
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, []);

  async function handleRenew(): Promise<void> {
    setRenewing(true);
    setRenewalError('');
    try {
      await renewSignIn();
      setRenewalRequired(false);
    } catch (err) {
      setRenewalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenewing(false);
    }
  }

  useEffect(() => {
    if (!AUTH_ENABLED) return;
    initAuth()
      .then((account) => {
        if (account !== null) {
          clearAutoAttempt();
          setState('signed-in');
          return;
        }
        // Signed out (e.g. a new browser session): go straight to Microsoft,
        // which usually signs in without a prompt. Once per tab, so a failed
        // sign-in shows the button instead of looping.
        if (!autoAttempted()) {
          markAutoAttempt();
          void signIn();
          return;
        }
        setState('signed-out');
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); setState('error'); });
  }, []);

  if (state === 'signed-in') return <>
    {renewalRequired && <div className="kh-auth-renewal" role="alert">
      <div>
        <p>Your sign-in has expired. Your work stays open while you sign in again.</p>
        {renewalError && <p className="kh-auth-renewal__error">Sign-in failed: {renewalError}</p>}
      </div>
      <button type="button" className="kh-btn-accent" disabled={renewing} onClick={() => { void handleRenew(); }}>
        {renewing ? 'Signing in...' : 'Sign in again'}
      </button>
    </div>}
    {children}
  </>;

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
