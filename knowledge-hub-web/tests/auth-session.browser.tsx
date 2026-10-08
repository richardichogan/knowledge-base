import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionExpiredDialog } from '../src/components/SessionExpiredDialog';
import { authSession } from '../src/services/authSession';
import '../src/styles/global.scss';

let attempts = 0;
createRoot(document.getElementById('root')!).render(<>
  <textarea aria-label="Unsaved note" defaultValue="Unsaved draft remains here" />
  <SessionExpiredDialog authenticate={async () => {
    attempts++;
    if (attempts === 1) throw new Error('Popup cancelled');
    authSession.setExpired(false);
  }} />
</>);
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Auth session fixture timed out');
}
function check(value: boolean, message: string): void { if (!value) throw new Error(message); }
async function runAuthSessionChecks(): Promise<string[]> {
  await waitFor(() => document.querySelector('dialog') !== null);
  const draft = document.querySelector('textarea')!;
  const dialog = document.querySelector('dialog')!;
  const location = window.location.href;
  check(!dialog.open, 'Dialog stays closed during normal usage');
  authSession.setExpired(true);
  await waitFor(() => dialog.open);
  const button = dialog.querySelector('button')!;
  check(button.textContent === 'Re-authenticate', 'Explicit re-authenticate action');
  check(document.activeElement === button, 'Keyboard focus moves into modal');
  check(dialog.textContent!.includes('Your sign-in has expired'), 'Clear expiration explanation');
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  check(cancel.defaultPrevented && dialog.open, 'Escape cannot bypass expired session');
  button.click();
  await waitFor(() => dialog.querySelector('[role="alert"]') !== null && !button.disabled);
  check(dialog.open, 'Cancellation leaves the prompt visible');
  button.click();
  await waitFor(() => !dialog.open);
  check(attempts === 2, 'User can retry re-authentication');
  check(document.querySelector('textarea') === draft && draft.value === 'Unsaved draft remains here', 'Editor stays mounted with unsaved text');
  check(window.location.href === location, 'No refresh or navigation');
  check(document.documentElement.scrollWidth <= window.innerWidth, 'No horizontal overflow');
  return ['expiration prompt', 'keyboard focus', 'cancel/retry', 'explicit action', 'unsaved draft preserved', 'no navigation', 'responsive layout'];
}
Object.assign(window, { runAuthSessionChecks });
