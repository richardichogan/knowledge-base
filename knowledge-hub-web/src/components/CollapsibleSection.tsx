/**
 * components/CollapsibleSection.tsx — generic clickable-header section that
 * expands/collapses its children, using the ChevronDown/ChevronRight pattern
 * already established in TagPanelTaxonomy.tsx.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from '@carbon/icons-react';

interface CollapsibleSectionProps {
  /** Section header label, e.g. "Details". */
  label: string;
  /** Whether the section starts expanded. Defaults to true. */
  defaultExpanded?: boolean;
  /** Optional extra class on the outer wrapper, e.g. to let a section grow to fill available height. */
  className?: string;
  /** Optional content rendered at the end of the header row, e.g. a live status indicator. */
  headerAdornment?: React.ReactNode;
  children: React.ReactNode;
}

/** A labelled section whose body can be toggled open/closed via its header. */
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  label,
  defaultExpanded = true,
  className,
  headerAdornment,
  children,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className={className ? `collapsible-section ${className}` : 'collapsible-section'}>
      <div className="collapsible-section__header-row">
        <button
          type="button"
          className="collapsible-section__header"
          onClick={() => { setExpanded((current) => !current); }}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="collapsible-section__label">{label}</span>
        </button>
        {headerAdornment && (
          <div className="collapsible-section__header-adornment">{headerAdornment}</div>
        )}
      </div>
      {expanded && (
        <div className="collapsible-section__body">
          {children}
        </div>
      )}
    </div>
  );
};
