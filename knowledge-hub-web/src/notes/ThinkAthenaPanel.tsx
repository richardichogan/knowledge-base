import React from 'react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';

interface ThinkAthenaPanelProps {
  pageContext?: AthenaPageContext | undefined;
  /** Reports whether Athena is currently generating a reply, so the caller can surface a live status indicator (e.g. on its tab). */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * Athena chat as it appears in the Think side panel's Athena tab.
 * Memoised: the editor re-renders its side panel on every keystroke (word
 * count, toolbar state), and re-rendering the whole chat each time caused
 * typing lag. It now only re-renders when the note context changes.
 */
export const ThinkAthenaPanel = React.memo<ThinkAthenaPanelProps>(({ pageContext, onBusyChange }) => (
  <div className="think-athena-panel think-athena-panel--metadata" aria-label="Athena">
    <div className="think-athena-panel__body">
      <AIChatPage compact compactVariant="narrow" pageContext={pageContext} onBusyChange={onBusyChange} />
    </div>
  </div>
));
ThinkAthenaPanel.displayName = 'ThinkAthenaPanel';
