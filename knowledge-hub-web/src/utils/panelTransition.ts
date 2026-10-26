import { flushSync } from 'react-dom';

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/** Slides workspace side panels open or closed; falls back to an instant change. */
export function slidePanels(update: () => void): void {
  const doc = document as TransitionDocument;
  if (typeof doc.startViewTransition !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  doc.startViewTransition(() => { flushSync(update); });
}
