import { isAuthCallback } from './services/authCallback';

// MSAL v5 popup responses must be relayed before React or any MSAL client
// starts. Loading the app here consumes the callback in the wrong window.
if (isAuthCallback(window.location)) {
  void import('./signinCallback').then(module => module.completeSignIn()).catch((error: unknown) => {
    console.error('[auth] Could not load sign-in callback:', error);
    const root = document.getElementById('root');
    if (root) {
      root.className = 'auth-callback';
      root.setAttribute('role', 'alert');
      root.textContent = 'Could not complete sign-in. Close this window and retry Re-authenticate in Athena.';
    }
  });
} else {
  void import('./appBootstrap');
}
