import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const asModule = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const sessionUrl = asModule(compile('../src/services/authSession.ts'));
const mockUrl = asModule(`
export class InteractionRequiredAuthError extends Error {}
export const BrowserCacheLocation = { LocalStorage: 'localStorage' };
export const CacheLookupPolicy = { AccessTokenAndRefreshToken: 'refresh' };
export class PublicClientApplication {
  constructor() { globalThis.authMock = this; this.account = { username: 'test' }; this.redirects = 0; this.calls = 0; }
  async initialize() {}
  async handleRedirectPromise() { return null; }
  getActiveAccount() { return this.account; }
  getAllAccounts() { return this.account ? [this.account] : []; }
  setActiveAccount(value) { this.account = value; }
  async acquireTokenSilent() {
    this.calls++;
    if (this.failure === 'expired') throw new InteractionRequiredAuthError('expired');
    if (this.failure === 'network') throw new Error('network');
    return { accessToken: 'test-token' };
  }
  async loginRedirect(request) { this.redirects++; this.lastRedirect = { type: 'login', request }; }
  async acquireTokenRedirect(request) { this.redirects++; this.lastRedirect = { type: 'token', request }; }
}
`);
globalThis.window = { location: { origin: 'https://example.test' }, localStorage: { getItem: () => null, setItem: () => {} } };
let source = compile('../src/services/auth.ts');
source = source.replaceAll("'@azure/msal-browser'", JSON.stringify(mockUrl))
  .replaceAll("'./authSession'", JSON.stringify(sessionUrl))
  .replaceAll("import.meta.env", "({ VITE_ENTRA_CLIENT_ID: 'test-client', VITE_ENTRA_TENANT_ID: 'test-tenant' })");
const auth = await import(asModule(source));
const { authSession, SessionExpiredError } = await import(sessionUrl);
const mock = globalThis.authMock;
const warn = console.warn;
let warnings = 0;
console.warn = () => { warnings++; };
await auth.initAuth();
assert.equal(await auth.getApiToken(), 'test-token');
mock.failure = 'expired';
const results = await Promise.allSettled([auth.getApiToken(), auth.getApiToken(), auth.getApiToken()]);
assert.ok(results.every(r => r.status === 'rejected' && r.reason instanceof SessionExpiredError));
assert.equal(mock.calls, 2, 'parallel requests share one renewal');
assert.equal(mock.redirects, 0, 'silent renewal does not navigate until the user acts');
assert.equal(authSession.isExpired(), true);
await assert.rejects(auth.getApiToken(), SessionExpiredError);
assert.equal(mock.calls, 2, 'expired requests do not repeat renewal');
await auth.reauthenticate();
assert.equal(authSession.isExpired(), true);
assert.equal(mock.redirects, 1, 'reauthentication uses the current tab, not a second popup');
assert.equal(mock.lastRedirect.type, 'token', 'signed-in account uses acquireTokenRedirect');
assert.equal(mock.lastRedirect.request.account.username, 'test');
await assert.rejects(auth.getApiToken(), SessionExpiredError, 'page awaits redirect return before renewing');
authSession.setExpired(false); // The full-page redirect returned in a newly loaded app.
mock.failure = 'network';
await assert.rejects(auth.getApiToken(), /network/);
assert.equal(authSession.isExpired(), false, 'network errors are not mislabeled as expired auth');
assert.equal(mock.redirects, 1);
mock.account = null;
await assert.rejects(auth.getApiToken(), SessionExpiredError);
assert.equal(mock.redirects, 1, 'missing account is not sent through a token renewal loop');
await auth.reauthenticate();
assert.equal(mock.redirects, 2, 'missing account uses same-tab login redirect');
assert.equal(mock.lastRedirect.type, 'login');
console.warn = warn;
assert.equal(warnings, 2, 'renewal failures are logged');
console.log('Auth regression checks passed: silent renewal, concurrency, explicit same-tab redirect renewal, network errors and missing-account recovery.');
