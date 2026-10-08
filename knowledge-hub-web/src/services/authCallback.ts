export function isAuthCallback(location: Pick<Location, 'pathname' | 'hash' | 'search'>): boolean {
  if (location.pathname !== '/signin') return false;
  return [location.hash.replace(/^#/, ''), location.search.replace(/^\?/, '')].some(value => {
    const params = new URLSearchParams(value);
    return params.has('state') && (params.has('code') || params.has('error'));
  });
}
