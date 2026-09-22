import { useEffect, useState } from 'react';

export const THINK_ATHENA_RAIL_QUERY = '(min-width: 1200px)';

/** Keeps React rendering aligned with a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => { setMatches(media.matches); };
    update();
    media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); };
  }, [query]);

  return matches;
}
