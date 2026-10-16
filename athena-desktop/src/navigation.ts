/** Where links and pop-ups from the Athena page are allowed to go. */

/** Microsoft sign-in pages MSAL opens in a pop-up. */
const SIGN_IN_HOSTS = new Set([
  'login.microsoftonline.com', 'login.live.com', 'login.windows.net', 'account.live.com',
  'mysignins.microsoft.com',
]);

export type WindowOpenDecision = 'athena' | 'sign-in' | 'blank' | 'external' | 'deny';

export type LaunchMode = 'workspace' | 'chat';

export function launchMode(args: readonly string[]): LaunchMode {
  return args.includes('--chat') ? 'chat' : 'workspace';
}

export function classifyUrl(url: string, athenaOrigin: string): WindowOpenDecision {
  if (url === '' || url === 'about:blank') return 'blank';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }
  if (parsed.origin === athenaOrigin) return 'athena';
  if (parsed.protocol === 'https:' && SIGN_IN_HOSTS.has(parsed.hostname)) return 'sign-in';
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') return 'external';
  return 'deny';
}

/** Only the Athena site itself may use the desktop bridge. */
export function isAthenaFrame(frameUrl: string | undefined, athenaOrigin: string): boolean {
  if (frameUrl === undefined) return false;
  try {
    return new URL(frameUrl).origin === athenaOrigin;
  } catch {
    return false;
  }
}
