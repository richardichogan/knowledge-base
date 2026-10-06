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

export const AUTH_REQUIRED_EVENT = 'kh-auth-required';

export class SignInRequiredError extends Error {
  constructor() {
    super('Your sign-in has expired. Sign in again above without leaving this page, then retry.');
    this.name = 'SignInRequiredError';
  }
}

function requireSignIn(): never {
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  throw new SignInRequiredError();
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

/** Explicit user gesture: renew in a popup without unloading the working app. */
export async function renewSignIn(): Promise<void> {
  if (msal === null) return;
  const loginHint = readHint();
  const result = await msal.acquireTokenPopup({
    scopes: API_SCOPES,
    ...(loginHint !== undefined && { loginHint }),
  });
  msal.setActiveAccount(result.account);
  saveHint(result.account.username);
}

/**
 * Access token for the Athena API ('' when sign-in is disabled). Renews
 * silently; interactive renewal is requested without navigating away.
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
  if (account === null) return requireSignIn();
  try {
    // Saved token, else the saved refresh token. No hidden-iframe fallback: a
    // managed work PC blocks it, so once the 24-hour sign-in expires every
    // request would hang. Interactive renewal is offered in a popup instead.
    const result = await msal.acquireTokenSilent({
      scopes: API_SCOPES,
      account,
      cacheLookupPolicy: CacheLookupPolicy.AccessTokenAndRefreshToken,
    });
    return result.accessToken;
  } catch (err) {
    console.warn('[auth] Silent token renewal failed; preserving the current page.', err);
    if (err instanceof InteractionRequiredAuthError) return requireSignIn();
    throw err;
  }
}
