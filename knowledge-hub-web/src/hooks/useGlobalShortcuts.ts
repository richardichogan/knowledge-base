/**
 * hooks/useGlobalShortcuts.ts
 * Registers global keyboard shortcuts at the document level.
 *
 * Currently handles:
 *   Cmd+. / Ctrl+.  — open the quick-spark capture modal
 *
 * Call this hook once at the top of AppShell. Pass setter callbacks
 * from AppShell state so the modal can be toggled from any page.
 */
import { useEffect } from 'react';

export interface GlobalShortcutHandlers {
  /** Called when the user presses Cmd+. or Ctrl+. */
  onSparkCapture: () => void;
}

/**
 * Registers global keyboard shortcuts for the application.
 * Must be called inside a component that is always mounted (e.g. AppShell).
 */
export function useGlobalShortcuts(handlers: GlobalShortcutHandlers): void {
  const { onSparkCapture } = handlers;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        e.stopPropagation();
        onSparkCapture();
      }
    };
    // Capture phase so it fires before editor key handlers
    document.addEventListener('keydown', handler, true);
    return () => { document.removeEventListener('keydown', handler, true); };
  }, [onSparkCapture]);
}
