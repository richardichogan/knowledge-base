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
  async acquireTokenPopup() {
    if (this.cancelPopup) throw new Error('cancelled');
    this.failure = null;
    return { account: this.account, accessToken: 'renewed-token' };
  }
  async loginPopup() { this.account = { username: 'test' }; return this.acquireTokenPopup(); }
  async loginRedirect() { this.redirects++; }
  async acquireTokenRedirect() { this.redirects++; }
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
assert.equal(mock.redirects, 0, 'expired auth must not navigate');
assert.equal(authSession.isExpired(), true);
await assert.rejects(auth.getApiToken(), SessionExpiredError);
assert.equal(mock.calls, 2, 'expired requests do not repeat renewal');
mock.cancelPopup = true;
await assert.rejects(auth.reauthenticate(), /cancelled/);
assert.equal(authSession.isExpired(), true);
mock.cancelPopup = false;
await auth.reauthenticate();
assert.equal(authSession.isExpired(), false);
assert.equal(await auth.getApiToken(), 'test-token');
mock.failure = 'network';
await assert.rejects(auth.getApiToken(), /network/);
assert.equal(authSession.isExpired(), false, 'network errors are not mislabeled as expired auth');
assert.equal(mock.redirects, 0);
mock.account = null;
await assert.rejects(auth.getApiToken(), SessionExpiredError);
assert.equal(mock.redirects, 0, 'missing account must not navigate');
await auth.reauthenticate();
assert.equal(authSession.isExpired(), false);
console.warn = warn;
assert.equal(warnings, 2, 'renewal failures are logged');
console.log('Auth regression checks passed: silent renewal, concurrency, expiration without redirects, blocked requests, popup cancellation/retry, network errors and missing account.');
