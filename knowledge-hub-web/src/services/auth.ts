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

const CLIENT_ID = import.meta.env['VITE_ENTRA_CLIENT_ID'] as string | undefined ?? '';
const TENANT_ID = import.meta.env['VITE_ENTRA_TENANT_ID'] as string | undefined ?? '';

export const AUTH_ENABLED = CLIENT_ID !== '' && TENANT_ID !== '';

// The account last used here, so Microsoft skips the account picker next time.
const HINT_KEY = 'kh_signin_hint';

function readHint(): string | undefined {
  try { return window.localStorage.getItem(HINT_KEY) ?? undefined; } catch { return undefined; }
}

const RENEW_KEY = 'kh_token_renew_redirect_at';
const RENEW_GUARD_MS = 120_000;

function renewRedirectAttemptedRecently(): boolean {
  try { return Date.now() - Number(window.sessionStorage.getItem(RENEW_KEY) ?? '0') < RENEW_GUARD_MS; } catch { return false; }
}

function markRenewRedirect(): void {
  try { window.sessionStorage.setItem(RENEW_KEY, Date.now().toString()); } catch { /* storage unavailable */ }
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
  if (msal === null) return Promise.resolve();
  const loginHint = readHint();
  return msal.loginRedirect({ scopes: API_SCOPES, ...(loginHint !== undefined && { loginHint }) });
}

export function signOut(): Promise<void> {
  if (msal === null) return Promise.resolve();
  return msal.logoutRedirect({ postLogoutRedirectUri: window.location.origin });
}

/**
 * Access token for the Athena API ('' when sign-in is disabled). Renews
 * silently; if Microsoft needs you to sign in again, redirects to do so.
 */
export function getApiToken(): Promise<string> {
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
    await signIn();
    return '';
  }
  try {
    // Saved token, else the saved refresh token. No hidden-iframe fallback: a
    // managed work PC blocks it, so once the 24-hour sign-in expires every
    // request would hang and fail instead of going to the sign-in page.
    const result = await msal.acquireTokenSilent({
      scopes: API_SCOPES,
      account,
      cacheLookupPolicy: CacheLookupPolicy.AccessTokenAndRefreshToken,
    });
    return result.accessToken;
  } catch (err) {
    // Expired sign-in (or any other failure to renew quietly) — sign in again
    // rather than failing every request. Guarded so a sign-in that keeps
    // failing can't loop.
    console.warn('[auth] Silent token renewal failed; signing in again.', err);
    if (err instanceof InteractionRequiredAuthError || !renewRedirectAttemptedRecently()) {
      markRenewRedirect();
      const loginHint = readHint();
      await msal.acquireTokenRedirect({ scopes: API_SCOPES, account, ...(loginHint !== undefined && { loginHint }) });
      return '';
    }
    throw err;
  }
}
