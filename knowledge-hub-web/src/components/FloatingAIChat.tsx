/**
 * FloatingAIChat — bottom-right floating chat bubble + popup panel.
 * Replaces the old header-dropdown/slide-over AI Chat entry point.
 */

import React, { useState } from 'react';
import { ChatLaunch, Close } from '@carbon/icons-react';
import { AIChatPage } from '../pages/AIChatPage';

export const FloatingAIChat: React.FC = () => {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="ai-float-panel" role="dialog" aria-label="AI Chat">
          <div className="ai-float-panel__header">
            <span className="ai-float-panel__title">Athena</span>
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
            <AIChatPage compact />
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
