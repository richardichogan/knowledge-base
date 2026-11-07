/**
 * Athena popup panel, opened from the floating launcher, ⌘J or a contextual item action,
 * on pages without an embedded Athena panel (everywhere except Think and Library).
 *
 * Accepts an optional `pageContext` prop which is passed through to AIChatPage
 * so Athena is primed with context about the item the user is currently viewing.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Close } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { deferredView } from '../utils/deferredView';
import type { AthenaPageContext } from '../context/AthenaContext';
import { useAthenaContext } from '../context/AthenaContext';
import { AthenaNews } from './athena/AthenaNews';

const AIChatPage = deferredView('Athena', async () => ({ default: (await import('../pages/AIChatPage')).AIChatPage }));

/** Views Athena may have changed with her tools; refreshed when she finishes a reply. */
const REFRESH_KEYS = ['today', 'tasks', 'task-assistance', 'notes-list', 'podcast-prep', 'upcoming-meetings',
  'projects', 'project-cockpit', 'project-register', 'review-packets', 'review-packet', 'packet-candidates', 'project-changes',
  'project-progress-reviews', 'project-progress-review', 'publishing', 'discover', 'cfps', 'watchlists', 'watchlist-runs',
  'watchlist-companies', 'work-drafts'];

interface FloatingAIChatProps {
  pageContext?: AthenaPageContext | undefined;
}

function athenaItemKey(context: AthenaPageContext): string {
  const area = context.type.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 40) || 'page';
  const id = (context.conversationId ?? context.id ?? 'area').replace(/\s+/g, '-').slice(0, 200);
  return `${area}:${id}`;
}

export const FloatingAIChat: React.FC<FloatingAIChatProps> = ({ pageContext }) => {
  // One conversation per selected item; with nothing selected, one per area (Today, Plan, Discover…).
  const itemKey = pageContext === undefined ? undefined : athenaItemKey(pageContext);
  const { request, clearAthenaRequest, launchSequence, floatOpen: open, setFloatOpen: setOpen, showNews } = useAthenaContext();
  const lastLaunch = useRef(launchSequence);
  const panelRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const wasBusy = useRef(false);
  useEffect(() => {
    if (lastLaunch.current === launchSequence) return;
    lastLaunch.current = launchSequence;
    setOpen(true);
    const frame = window.requestAnimationFrame(() => { panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); });
    return () => { window.cancelAnimationFrame(frame); };
  }, [launchSequence, setOpen]);
  useEffect(() => {
    if (request !== null) setOpen(true);
  }, [request, setOpen]);
  // Leaving for Think or Library unmounts this panel; the launcher must come back there.
  useEffect(() => () => { setOpen(false); }, [setOpen]);

  const close = useCallback((): void => { clearAthenaRequest(); showNews(null); setOpen(false); }, [clearAthenaRequest, showNews, setOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        if (open) close(); else setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [open, close, setOpen]);

  const handleBusyChange = useCallback((busy: boolean): void => {
    if (wasBusy.current && !busy) {
      for (const key of REFRESH_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    wasBusy.current = busy;
  }, [queryClient]);

  return (
    <>
      {open && (
        <div ref={panelRef} className="ai-float-panel" role="dialog" aria-label="Athena">
          <div className="ai-float-panel__header">
            <span className="ai-float-panel__title">Athena</span>
            {pageContext && (
              <span className="ai-float-panel__context-badge" title={pageContext.title}>
                {pageContext.title.length > 28 ? `${pageContext.title.slice(0, 28)}…` : pageContext.title}
              </span>
            )}
            <button type="button" className="ai-float-panel__close" aria-label="Close Athena" title="Close Athena (⌘J / Ctrl+J)" onClick={close}>
              <Close size={16} />
            </button>
          </div>
          <AthenaNews />
          <div className="ai-float-panel__body">
            <AIChatPage compact pageContext={pageContext} itemKey={itemKey} promptRequest={request ?? undefined} onBusyChange={handleBusyChange} />
          </div>
        </div>
      )}
    </>
  );
};
