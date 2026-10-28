/**
 * features/diagram/DiagramControls.tsx — icon buttons and segmented choices
 * shared by the diagram and brainstorm editors.
 */
import React from 'react';
import type { PaneWidthOptions } from '../../hooks/usePersistedState';

/** Width of the right-hand side panel on diagrams and brainstorms. */
export const CANVAS_SIDE_WIDTH: PaneWidthOptions = { compact: 380, wide: 460, min: 300, max: (viewport) => Math.round(viewport * 0.45) };

export function IconBtn({ label, onClick, disabled, pressed, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean | undefined; pressed?: boolean | undefined; danger?: boolean | undefined; children: React.ReactNode;
}): React.ReactElement {
  const cls = ['dg-btn', pressed === true ? 'dg-btn--active' : '', danger === true ? 'dg-btn--danger' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange, compact }: {
  label: string; value: string; options: readonly { value: T; label: string; glyph?: React.ReactNode }[];
  onChange: (value: T) => void; compact?: boolean | undefined;
}): React.ReactElement {
  return (
    <div className={`dg-segment${compact === true ? ' dg-segment--compact' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.label} aria-label={o.label}
          className={`dg-segment__option${value === o.value ? ' dg-segment__option--selected' : ''}`}
          onClick={() => { onChange(o.value); }}
        >
          {o.glyph ?? o.label}
        </button>
      ))}
    </div>
  );
}
