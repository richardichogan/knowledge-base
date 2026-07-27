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
  children: React.ReactNode;
}

/** A labelled section whose body can be toggled open/closed via its header. */
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  label,
  defaultExpanded = true,
  children,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="collapsible-section">
      <button
        type="button"
        className="collapsible-section__header"
        onClick={() => { setExpanded((v) => !v); }}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="collapsible-section__label">{label}</span>
      </button>
      {expanded && (
        <div className="collapsible-section__body">
          {children}
        </div>
      )}
    </div>
  );
};
