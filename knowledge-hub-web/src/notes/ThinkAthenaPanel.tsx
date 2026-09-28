import React from 'react';
import { AIChatPage } from '../pages/AIChatPage';
import type { AthenaPageContext } from '../context/AthenaContext';
import { PaneResizer } from '../components/PaneResizer';
import { usePersistedPaneWidth } from '../hooks/usePersistedState';

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
}) => {
  const [width, setWidth] = usePersistedPaneWidth('think-athena', {
    compact: 400,
    wide: 560,
    min: 340,
    // Athena is a companion to the note, never the main event, so it can
    // never take more than half the window however hard it is dragged.
    max: (viewport) => Math.round(viewport * 0.5),
  });

  // Only the standalone rail owns a width — when Athena is embedded in the
  // metadata column its host controls the size, so forcing one here would
  // fight that container.
  const isRail = placement !== 'metadata';

  return (
    <>
      {isRail && (
        <PaneResizer width={width} onResize={setWidth} side="right" label="Resize Athena panel" />
      )}
      <aside
        className={`think-athena-panel think-athena-panel--${placement}`}
        aria-label="Athena"
        {...(isRail
          ? { style: { width: `${String(width)}px`, minWidth: `${String(width)}px` } }
          : {})}
      >
        {isRail && (
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
    </>
  );
};
