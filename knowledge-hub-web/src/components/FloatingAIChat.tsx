/**
 * Athena popup panel, opened from the toolbar or a contextual item action.
 *
 * Accepts an optional `pageContext` prop which is passed through to AIChatPage
 * so Athena is primed with context about the item the user is currently viewing.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Close } from '@carbon/icons-react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';
import { useAthenaContext } from '../context/AthenaContext';

interface FloatingAIChatProps {
  pageContext?: AthenaPageContext | undefined;
}

export const FloatingAIChat: React.FC<FloatingAIChatProps> = ({ pageContext }) => {
  const [open, setOpen] = useState(false);
  const { request, clearAthenaRequest, launchSequence } = useAthenaContext();
  const lastLaunch = useRef(launchSequence);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (lastLaunch.current === launchSequence) return;
    lastLaunch.current = launchSequence;
    setOpen(true);
    const frame = window.requestAnimationFrame(() => { panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); });
    return () => { window.cancelAnimationFrame(frame); };
  }, [launchSequence]);
  useEffect(() => {
    if (request !== null) setOpen(true);
  }, [request]);

  return (
    <>
      {open && (
        <div ref={panelRef} className="ai-float-panel" role="dialog" aria-label="AI Chat">
          <div className="ai-float-panel__header">
            <span className="ai-float-panel__title">Athena</span>
            {pageContext && (
              <span className="ai-float-panel__context-badge" title={pageContext.title}>
                {pageContext.title.length > 28 ? `${pageContext.title.slice(0, 28)}…` : pageContext.title}
              </span>
            )}
            <button
              type="button"
              className="ai-float-panel__close"
              aria-label="Close AI Chat"
              onClick={() => { clearAthenaRequest(); setOpen(false); }}
            >
              <Close size={16} />
            </button>
          </div>
          <div className="ai-float-panel__body">
            <AIChatPage compact pageContext={pageContext} promptRequest={request ?? undefined} />
          </div>
        </div>
      )}
    </>
  );
};
