import { isAuthCallback } from '../src/services/authCallback';

function check(condition: boolean, message: string): void { if (!condition) throw new Error(message); }
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Callback check timed out');
}
function response(id: string, interactionType: string, error = false): string {
  const state = btoa(JSON.stringify({ id, meta: { interactionType } }));
  return new URLSearchParams({ state, ...(error ? { error: 'access_denied', error_description: 'Test cancellation' } : { code: 'test-only-code' }) }).toString();
}
async function runAuthCallbackChecks(): Promise<string[]> {
  check(isAuthCallback({ pathname: '/signin', hash: '#code=x&state=y', search: '' }), 'Hash callback detected');
  check(isAuthCallback({ pathname: '/signin', hash: '', search: '?error=access_denied&state=y' }), 'Query error callback detected');
  check(!isAuthCallback({ pathname: '/think', hash: '#code=x&state=y', search: '' }), 'Other routes not mistaken for callback');
  check(!isAuthCallback({ pathname: '/signin', hash: '', search: '' }), 'Direct sign-in still loads normal app');
  check(!isAuthCallback({ pathname: '/signin', hash: '#code=x', search: '' }), 'Requires MSAL state');

  for (const query of [false, true]) {
    const id = crypto.randomUUID();
    const channel = new BroadcastChannel(id);
    let received: { v: number; payload: string } | null = null;
    channel.onmessage = event => { received = event.data; };
    const frame = document.createElement('iframe');
    const payload = response(id, 'popup', query);
    frame.src = `/signin${query ? '?' : '#'}${payload}`;
    document.body.append(frame);
    try {
      await waitFor(() => received !== null);
      check(received!.v === 1 && received!.payload.includes(query ? 'access_denied' : 'test-only-code'), 'Real MSAL bridge relays complete callback');
      await waitFor(() => frame.contentDocument?.querySelector('.auth-callback') !== null);
      check(frame.contentDocument!.querySelector('.pw-gate') === null, 'Callback never mounts sign-in controls');
      check(frame.contentDocument!.querySelector('[role="alert"]') === null, 'No nested popup error');
      check(frame.contentWindow!.location.hash === '' && frame.contentWindow!.location.search === '', 'Response removed from callback URL after relay');
      const resources = frame.contentWindow!.performance.getEntriesByType('resource');
      check(!resources.some(item => /appBootstrap|SignInGate/.test(item.name)), 'App/auth bootstrap not even imported in callback');
    } finally { frame.remove(); channel.close(); }
  }

  const malformed = document.createElement('iframe');
  malformed.src = '/signin#code=test-only-code&state=invalid';
  document.body.append(malformed);
  try {
    await waitFor(() => malformed.contentDocument?.querySelector('.auth-callback[role="alert"]') !== null);
    check(malformed.contentDocument!.querySelector('.pw-gate') === null, 'Malformed callback does not restart authentication');
    check(malformed.contentDocument!.body.textContent!.includes('retry Re-authenticate'), 'Malformed callback gives recovery instructions');
  } finally { malformed.remove(); }

  const popupId = crypto.randomUUID();
  const channel = new BroadcastChannel(popupId);
  let received = false;
  channel.onmessage = () => { received = true; };
  const popup = window.open(`/signin#${response(popupId, 'popup')}`, 'athena-auth-test', 'width=400,height=500');
  check(popup !== null, 'Test popup opened');
  const originalUrl = window.location.href;
  const originalRoot = document.getElementById('root');
  const draft = document.createElement('textarea');
  draft.value = 'Keep this unsent draft while the sign-in popup completes.';
  document.body.append(draft);
  try {
    await waitFor(() => received);
    await waitFor(() => popup!.closed);
    check(window.location.href === originalUrl && document.getElementById('root') === originalRoot,
      'Popup callback never navigates or remounts the original page');
    check(draft.isConnected && draft.value === 'Keep this unsent draft while the sign-in popup completes.',
      'Unsent work remains mounted throughout popup completion');
  } finally { if (!popup!.closed) popup!.close(); channel.close(); draft.remove(); }

  // Exercise the real MSAL redirect bridge's return-to-origin path.
  const redirectId = crypto.randomUUID();
  const redirectPayload = response(redirectId, 'redirect');
  const chatSessionId = crypto.randomUUID();
  const chatDraft = 'Keep this unsent Athena chat draft through same-tab sign-in.';
  const chatDraftKey = `kh-athena-session-id-standalone-draft-${chatSessionId}`;
  localStorage.setItem('kh-athena-session-id-standalone', chatSessionId);
  sessionStorage.setItem(chatDraftKey, chatDraft);
  sessionStorage.setItem('msal.interaction.status', JSON.stringify({ clientId: 'test-client', type: 'redirect' }));
  sessionStorage.setItem('msal.test-client.request.origin', `${location.origin}/chat?session=${chatSessionId}`);
  const frame = document.createElement('iframe');
  frame.src = `/signin#${redirectPayload}`;
  document.body.append(frame);
  try {
    await waitFor(() => frame.contentWindow?.location.pathname === '/chat'
      && frame.contentDocument?.querySelector('#ai-chat-input') !== null);
    check(sessionStorage.getItem('msal.test-client.urlHash') === redirectPayload, 'Redirect response cached for normal handleRedirectPromise');
    check(frame.contentWindow!.location.search === `?session=${chatSessionId}`, 'Redirect returns to the standalone chat route and selected session');
    check(frame.contentDocument!.querySelector<HTMLTextAreaElement>('#ai-chat-input')?.value === chatDraft,
      'Standalone chat restores the unsent draft after a full-page auth return');
    check(localStorage.getItem('kh-athena-session-id-standalone') === chatSessionId, 'Standalone chat keeps the selected conversation');
  } finally {
    frame.remove();
    localStorage.removeItem('kh-athena-session-id-standalone');
    sessionStorage.removeItem(chatDraftKey);
    sessionStorage.removeItem('msal.interaction.status');
    sessionStorage.removeItem('msal.test-client.request.origin');
    sessionStorage.removeItem('msal.test-client.urlHash');
  }
  return ['hash and query callbacks', 'OAuth errors relayed', 'real MSAL broadcast bridge', 'no app/sign-in bootstrap in callback',
    'popup closes after relay without navigating or remounting Athena or its unsent work',
    'full-page redirect returns to /chat and restores its session and unsent draft',
    'malformed callbacks fail without nested sign-in', 'direct /signin remains normal app'];
}
Object.assign(window, { runAuthCallbackChecks });
