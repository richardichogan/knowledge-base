import React from 'react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';

interface ThinkAthenaPanelProps {
  pageContext?: AthenaPageContext | undefined;
  placement?: 'rail' | 'metadata';
  /** Reports whether Athena is currently generating a reply, so the caller can surface a live status indicator (e.g. in a collapsible section header). */
  onBusyChange?: (busy: boolean) => void;
}

/** Persistent Athena workspace used only on desktop Think layouts. */
export const ThinkAthenaPanel: React.FC<ThinkAthenaPanelProps> = ({
  pageContext,
  placement = 'rail',
  onBusyChange,
}) => (
  <aside className={`think-athena-panel think-athena-panel--${placement}`} aria-label="Athena">
    {placement !== 'metadata' && (
      <div className="think-athena-panel__header">
        <span className="think-athena-panel__title">Athena</span>
        {pageContext && (
          <span className="think-athena-panel__context" title={pageContext.title}>
            {pageContext.title}
          </span>
        )}
      </div>
    )}
    <div className="think-athena-panel__body">
      <AIChatPage compact compactVariant="narrow" pageContext={pageContext} onBusyChange={onBusyChange} />
    </div>
  </aside>
);
