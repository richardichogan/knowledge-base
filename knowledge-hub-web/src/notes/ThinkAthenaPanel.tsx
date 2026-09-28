import React from 'react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';

interface ThinkAthenaPanelProps {
  pageContext?: AthenaPageContext | undefined;
  /** Reports whether Athena is currently generating a reply, so the caller can surface a live status indicator (e.g. on its tab). */
  onBusyChange?: (busy: boolean) => void;
}

/** Athena chat as it appears in the Think side panel's Athena tab. */
export const ThinkAthenaPanel: React.FC<ThinkAthenaPanelProps> = ({ pageContext, onBusyChange }) => (
  <div className="think-athena-panel think-athena-panel--metadata" aria-label="Athena">
    <div className="think-athena-panel__body">
      <AIChatPage compact compactVariant="narrow" pageContext={pageContext} onBusyChange={onBusyChange} />
    </div>
  </div>
);
