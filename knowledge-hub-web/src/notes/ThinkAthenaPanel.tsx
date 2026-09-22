import React from 'react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';

interface ThinkAthenaPanelProps {
  pageContext?: AthenaPageContext | undefined;
}

/** Persistent Athena workspace used only on wide Think layouts. */
export const ThinkAthenaPanel: React.FC<ThinkAthenaPanelProps> = ({ pageContext }) => (
  <aside className="think-athena-panel" aria-label="Athena">
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
