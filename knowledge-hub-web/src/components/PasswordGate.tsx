/**
 * PasswordGate.tsx — Simple password protection for the prod frontend.
 * The password is hashed at build time via VITE_APP_PASSWORD_HASH.
 * Auth state is kept in sessionStorage so re-auth is only needed per tab.
 */
import React, { useState } from 'react';

const HASH = import.meta.env['VITE_APP_PASSWORD_HASH'] as string | undefined ?? '';
const SESSION_KEY = 'kh_authed';

async function sha256(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isAuthed(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === '1';
}

interface Props { children: React.ReactNode; }

export const PasswordGate: React.FC<Props> = ({ children }) => {
  const [authed, setAuthed] = useState(isAuthed());
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  // No hash configured (local dev) — pass straight through
  if (!HASH) return <>{children}</>;
  if (authed) return <>{children}</>;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const h = await sha256(value);
    if (h === HASH) {
      sessionStorage.setItem(SESSION_KEY, '1');
      setAuthed(true);
    } else {
      setError(true);
      setValue('');
    }
  }

  return (
    <div className="pw-gate">
      <form className="pw-gate__form" onSubmit={(e) => { void handleSubmit(e); }}>
        <p className="pw-gate__label">Knowledge Hub</p>
        <input
          className={`pw-gate__input${error ? ' pw-gate__input--error' : ''}`}
          type="password"
          placeholder="Password"
          autoFocus
          value={value}
          onChange={e => { setValue(e.target.value); setError(false); }}
        />
        {error && <p className="pw-gate__error">Incorrect password</p>}
        <button className="kh-btn-accent pw-gate__btn" type="submit">Enter</button>
      </form>
    </div>
  );
};
