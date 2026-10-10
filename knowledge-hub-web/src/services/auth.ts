/**
 * services/auth.ts — Microsoft sign-in (Entra ID, IBM Alliance tenant) via MSAL.
 *
 * Enabled when VITE_ENTRA_CLIENT_ID and VITE_ENTRA_TENANT_ID are set (the
 * production build). Without them (local dev) sign-in is skipped and API
 * calls go out without a token, as before.
 */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  BrowserCacheLocation,
  CacheLookupPolicy,
  type AccountInfo,
} from '@azure/msal-browser';
import { authSession, SessionExpiredError } from './authSession';

const CLIENT_ID = import.meta.env['VITE_ENTRA_CLIENT_ID'] as string | undefined ?? '';
const TENANT_ID = import.meta.env['VITE_ENTRA_TENANT_ID'] as string | undefined ?? '';

export const AUTH_ENABLED = CLIENT_ID !== '' && TENANT_ID !== '';

// The account last used here, so Microsoft skips the account picker next time.
const HINT_KEY = 'kh_signin_hint';

function readHint(): string | undefined {
  try { return window.localStorage.getItem(HINT_KEY) ?? undefined; } catch { return undefined; }
}

function saveHint(username: string): void {
  try { window.localStorage.setItem(HINT_KEY, username); } catch { /* storage unavailable */ }
}

const API_SCOPES = [`api://${CLIENT_ID}/access_as_user`];

const msal = AUTH_ENABLED
  ? new PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
        // A path of its own: Entra ignores the port on localhost addresses, so the
        // bare origin would collide with the backend's http://localhost:3000.
        redirectUri: `${window.location.origin}/signin`,
      },
      // localStorage so one sign-in covers every tab and survives restarts.
      cache: { cacheLocation: BrowserCacheLocation.LocalStorage },
    })
  : null;

/**
 * Completes a sign-in redirect if we're returning from one and picks the
 * signed-in account. Returns the account, or null if nobody is signed in.
 */
export async function initAuth(): Promise<AccountInfo | null> {
  if (msal === null) return null;
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  const account = result?.account ?? msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
  if (account !== null) {
    msal.setActiveAccount(account);
    saveHint(account.username);
  }
  return account;
}

export function signIn(): Promise<void> {
  return reauthenticate();
}

export function signOut(): Promise<void> {
  if (msal === null) return Promise.resolve();
  return msal.logoutRedirect({ postLogoutRedirectUri: window.location.origin });
}

let interactiveInFlight: Promise<void> | null = null;

/** Open one user-initiated popup, leaving Athena and unsaved work mounted. */
export function reauthenticate(): Promise<void> {
  if (msal === null) return Promise.resolve();
  interactiveInFlight ??= authenticateInPopup().finally(() => { interactiveInFlight = null; });
  return interactiveInFlight;
}

async function authenticateInPopup(): Promise<void> {
  if (msal === null) return;
  const account = msal.getActiveAccount();
  const loginHint = readHint();
  const request = { scopes: API_SCOPES, ...(loginHint !== undefined && { loginHint }) };
  const result = account === null
    ? await msal.loginPopup(request)
    : await msal.acquireTokenPopup({ ...request, account });
  if (result.account === null) throw new Error('Microsoft sign-in returned no account. Please try again.');
  msal.setActiveAccount(result.account);
  saveHint(result.account.username);
  authSession.setExpired(false);
}

/**
 * Access token for the Athena API ('' when sign-in is disabled). Renews
 * silently; interactive renewal is explicitly requested through the UI.
 */
export function getApiToken(): Promise<string> {
  if (authSession.isExpired()) return Promise.reject(new SessionExpiredError());
  // One renewal shared by every request on the page, so a dozen parallel calls
  // don't each try to renew and then race each other to the sign-in page.
  inFlight ??= renewToken().finally(() => { inFlight = null; });
  return inFlight;
}

let inFlight: Promise<string> | null = null;

async function renewToken(): Promise<string> {
  if (msal === null) return '';
  const account = msal.getActiveAccount();
  if (account === null) {
    authSession.setExpired(true);
    throw new SessionExpiredError();
  }
  try {
    // Saved token, else the saved refresh token. No hidden-iframe fallback: a
    // managed work PC blocks it. Interactive renewal waits for user consent.
    const result = await msal.acquireTokenSilent({
      scopes: API_SCOPES,
      account,
      cacheLookupPolicy: CacheLookupPolicy.AccessTokenAndRefreshToken,
    });
    return result.accessToken;
  } catch (err) {
    console.warn('[auth] Silent token renewal failed.', err);
    if (err instanceof InteractionRequiredAuthError) {
      authSession.setExpired(true);
      throw new SessionExpiredError();
    }
    throw err;
  }
}
