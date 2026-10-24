import type { Location } from 'react-router-dom';

export type SettingsView = 'memory' | 'sync' | 'repo-projects' | 'jobs';

export function settingsView(pathname: string, search = ''): SettingsView | undefined {
  if (pathname === '/memory') return 'memory';
  if (pathname === '/jobs') return 'jobs';
  if (pathname === '/settings/repo-mappings') return 'repo-projects';
  if (pathname === '/my-work' && new URLSearchParams(search).get('sync') === '1') return 'sync';
  return undefined;
}

export function settingsLinkState(location: Location): { settingsBackground: Location } {
  return { settingsBackground: location };
}

export function settingsBackground(location: Location): Location | undefined {
  const state: unknown = location.state;
  if (typeof state !== 'object' || state === null || !('settingsBackground' in state)) return undefined;
  const background = state.settingsBackground;
  if (typeof background !== 'object' || background === null
    || !('pathname' in background) || typeof background.pathname !== 'string'
    || !('search' in background) || typeof background.search !== 'string'
    || !('hash' in background) || typeof background.hash !== 'string'
    || !('key' in background) || typeof background.key !== 'string'
    || !background.pathname.startsWith('/') || background.pathname.startsWith('//')
    || settingsView(background.pathname, background.search) !== undefined) return undefined;
  return {
    pathname: background.pathname, search: background.search, hash: background.hash,
    key: background.key, state: 'state' in background ? background.state : null,
  };
}
