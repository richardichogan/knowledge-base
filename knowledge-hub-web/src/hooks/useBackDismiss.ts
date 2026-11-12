import { useEffect, useRef } from 'react';

type Entry = { id: number; dismiss: () => void; popped: boolean };

const stack: Entry[] = [];
let ignoredPops = 0;
let listening = false;
let nextId = 1;

function onPopState(): void {
  if (ignoredPops > 0) { ignoredPops -= 1; return; }
  const top = stack.pop();
  if (top) { top.popped = true; top.dismiss(); }
}

/**
 * Android Back (and browser Back) closes the topmost open mobile layer — the Tasks tab, chat
 * history drawer or settings sheet — instead of leaving the installed app. Each active layer
 * owns one history entry; closing it from the UI removes that entry again.
 */
export function useBackDismiss(active: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!active) return undefined;
    if (!listening) { window.addEventListener('popstate', onPopState); listening = true; }
    const entry: Entry = { id: nextId++, dismiss: () => { dismissRef.current(); }, popped: false };
    stack.push(entry);
    // Keep the router's own state so the extra entry resolves to the same route.
    const current: unknown = window.history.state;
    window.history.pushState({ ...(typeof current === 'object' && current !== null ? current : {}), athenaLayer: entry.id }, '');
    return () => {
      if (entry.popped) return;
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      // Defer so a remount (React StrictMode) or a newer layer can take over; only step back
      // when this layer's own entry is still the current one.
      window.setTimeout(() => {
        const state: unknown = window.history.state;
        if (typeof state === 'object' && state !== null && (state as { athenaLayer?: number }).athenaLayer === entry.id) {
          ignoredPops += 1;
          window.history.back();
        }
      }, 0);
    };
  }, [active]);
}
