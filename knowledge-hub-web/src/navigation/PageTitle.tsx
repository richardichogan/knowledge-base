import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { useAthenaContext } from '../context/AthenaContext';
import { buildDocumentTitle, formatTitleDate, sectionTitle } from './documentTitle';

export interface PageTitleParts {
  /** The sub-view in use, e.g. "Sparks" on Think or "Watchlists" on Discover. */
  view?: string | null | undefined;
  /** The open item when the page doesn't publish one to Athena's context. */
  item?: string | null | undefined;
}

let current: PageTitleParts = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = (): PageTitleParts => current;

/** Lets a page add its current view and/or item to the browser tab title. An empty call is a no-op. */
export function usePageTitle({ view = null, item = null }: PageTitleParts): void {
  useEffect(() => {
    if (!view && !item) return undefined;
    const parts = { view, item };
    current = parts;
    listeners.forEach((listener) => { listener(); });
    return () => {
      if (current !== parts) return;
      current = {};
      listeners.forEach((listener) => { listener(); });
    };
  }, [view, item]);
}

function msUntilMidnight(): number {
  const next = new Date();
  next.setHours(24, 0, 5, 0);
  return next.getTime() - Date.now();
}

/** Keeps document.title in step with the route, view and open item. */
export function DocumentTitleSync(): null {
  const { pathname, search } = useLocation();
  const { pageContext } = useAthenaContext();
  const page = useSyncExternalStore(subscribe, snapshot);
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setTimeout(() => { setToday(new Date()); }, msUntilMidnight());
    return () => { window.clearTimeout(timer); };
  }, [today]);

  const section = sectionTitle(pathname, search);
  const item = page.item ?? pageContext?.title;
  const title = buildDocumentTitle([item, page.view, section, pathname === '/' ? formatTitleDate(today) : null]);
  useEffect(() => { document.title = title; }, [title]);
  return null;
}
