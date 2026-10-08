import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';
import './styles/signinCallback.scss';

export async function completeSignIn(): Promise<void> {
  const root = document.getElementById('root');
  if (root) {
    root.className = 'auth-callback';
    root.textContent = 'Completing Microsoft sign-in...';
  }
  try {
    // Relays popup/iframe responses and resumes full-page redirect sign-in.
    // Do not initialise a PublicClientApplication in this callback window.
    await broadcastResponseToMainFrame();
    if (root) root.textContent = 'Sign-in response returned to Athena. You can close this window.';
  } catch (error) {
    console.error('[auth] Could not complete sign-in callback:', error);
    if (root) {
      root.setAttribute('role', 'alert');
      root.textContent = 'Could not complete sign-in. Close this window and retry Re-authenticate in Athena.';
    }
  }
}
