import React from 'react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';

interface ThinkAthenaPanelProps {
  pageContext?: AthenaPageContext | undefined;
  placement?: 'rail' | 'metadata';
}

/** Persistent Athena workspace used only on desktop Think layouts. */
export const ThinkAthenaPanel: React.FC<ThinkAthenaPanelProps> = ({
  pageContext,
  placement = 'rail',
}) => (
  <aside className={`think-athena-panel think-athena-panel--${placement}`} aria-label="Athena">
    <div className="think-athena-panel__header">
      <span className="think-athena-panel__title">Athena</span>
      {pageContext && (
        <span className="think-athena-panel__context" title={pageContext.title}>
          {pageContext.title}
        </span>
      )}
    </div>
    <div className="think-athena-panel__body">
      <AIChatPage compact pageContext={pageContext} />
    </div>
  </aside>
);
