/** Blog results open over the current workspace instead of replacing its route. */
export function specialistLink(url: string, currentHref: string): string {
  if (!url.startsWith('?blogJob=')) return url;
  const incoming = new URLSearchParams(url.slice(1));
  const id = incoming.get('blogJob');
  if (!id) return url;
  const current = new URL(currentHref);
  current.searchParams.set('blogJob', id);
  return `${current.pathname}${current.search}${current.hash}`;
}
