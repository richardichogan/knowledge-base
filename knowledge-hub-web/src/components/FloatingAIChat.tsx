/**
 * FloatingAIChat — bottom-right floating chat bubble + popup panel.
 * Replaces the old header-dropdown/slide-over AI Chat entry point.
 *
 * Accepts an optional `pageContext` prop which is passed through to AIChatPage
 * so Athena is primed with context about the item the user is currently viewing.
 */

import React, { useState } from 'react';
import { ChatLaunch, Close } from '@carbon/icons-react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';

interface FloatingAIChatProps {
  pageContext?: AthenaPageContext | undefined;
}

export const FloatingAIChat: React.FC<FloatingAIChatProps> = ({ pageContext }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="ai-float-panel" role="dialog" aria-label="AI Chat">
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
              onClick={() => setOpen(false)}
            >
              <Close size={16} />
            </button>
          </div>
          <div className="ai-float-panel__body">
            <AIChatPage compact pageContext={pageContext} />
          </div>
        </div>
      )}
      <button
        type="button"
        className="ai-float-button"
        aria-label={open ? 'Close AI Chat' : 'Open AI Chat'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <Close size={22} /> : <ChatLaunch size={22} />}
      </button>
    </>
  );
};
