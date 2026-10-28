import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { readStored, writeStored } from '../hooks/usePersistedState';

const AREAS = ['/think', '/discover', '/plan', '/build', '/projects', '/my-work', '/library'];
const positions = new Map<string, Map<string, number>>();
const SCROLLERS = ['.kh-content', '.notes-list', '.notes-editor-scroll'];

export function resumeWorkspacePath(path: string): string {
  if (!AREAS.includes(path)) return path;
  const saved = readStored(`kh-resume:${path}`);
  return saved && (saved === path || saved.startsWith(`${path}?`)) ? saved : path;
}

/** Explicit deep links always win; only navigation to an area's root resumes it. */
export function useWorkspaceContinuity(): void {
  const location = useLocation();
  const key = `${location.pathname}${location.search}`;
  useLayoutEffect(() => {
    if (AREAS.includes(location.pathname)) writeStored(`kh-resume:${location.pathname}`, key);
    const saved = positions.get(key);
    const pending = new Map(saved);
    const capture = (event: Event): void => {
      if (!(event.target instanceof HTMLElement)) return;
      const target = event.target;
      const selector = SCROLLERS.find(item => target.matches(item));
      if (!selector) return;
      // Programmatic restoration must not overwrite a position before content loads.
      if (pending.has(selector)) return;
      const next = positions.get(key) ?? new Map<string, number>();
      next.set(selector, target.scrollTop);
      positions.set(key, next);
      if (positions.size > 80) positions.delete(positions.keys().next().value!);
    };
    const restore = (): void => {
      for (const [selector, top] of pending) {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element || element.scrollHeight - element.clientHeight < top) continue;
        element.scrollTop = top;
        pending.delete(selector);
      }
    };
    const cancel = (): void => { pending.clear(); observer.disconnect(); };
    const observer = new MutationObserver(restore);
    if (pending.size) observer.observe(document.querySelector('.kh-shell') ?? document.body, { childList: true, subtree: true });
    document.addEventListener('scroll', capture, true);
    document.addEventListener('wheel', cancel, { once: true, passive: true });
    document.addEventListener('pointerdown', cancel, { once: true });
    const timer = window.setTimeout(cancel, 5000);
    restore();
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      document.removeEventListener('scroll', capture, true);
      document.removeEventListener('wheel', cancel);
      document.removeEventListener('pointerdown', cancel);
    };
  }, [key, location.pathname]);
}
