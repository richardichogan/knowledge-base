/**
 * features/diagram/DiagramControls.tsx — icon buttons and segmented choices
 * shared by the diagram and brainstorm editors.
 */
import React from 'react';
import { ChevronDown } from '@carbon/icons-react';
import type { PaneWidthOptions } from '../../hooks/usePersistedState';
import { IBM_COLOURS } from './diagramPalette';
import { diagramEditorFill } from './diagramTheme';
import { diagramGridSize } from './diagramAlignment';

/** Width of the right-hand side panel on diagrams and brainstorms. */
export const CANVAS_SIDE_WIDTH: PaneWidthOptions = { compact: 380, wide: 460, min: 300, max: (viewport) => Math.round(viewport * 0.45) };

export function SnapControls({ grid, shapes, gridSize, onToggle, onGridSize, hint, onOpen }: {
  grid: boolean; shapes: boolean; gridSize: number;
  onToggle: (kind: 'grid' | 'shapes') => void; onGridSize: (size: number) => void; hint?: string; onOpen?: () => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const anchor = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('pointerdown', close); };
  }, [open]);
  return <>
    <div className="dg-anchor" ref={anchor} onKeyDown={(event) => {
      if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    }}>
      <button ref={trigger} type="button" className="dg-text-btn dg-snap-toggle" aria-label="Snapping options"
        aria-haspopup="dialog" aria-expanded={open} title={hint ?? 'Snapping options. Hold Alt to temporarily bypass snapping and guides.'}
        onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>Snap <ChevronDown size={12} /></button>
      {open && <div className="dg-popover" role="dialog" aria-label="Snapping options">
        <label className="dg-check">
          <input className="dg-check__input" type="checkbox" checked={grid} onChange={() => { onToggle('grid'); }} />
          <span className="dg-check__label">Grid snap</span>
        </label>
        <label className="dg-check">
          <input className="dg-check__input" type="checkbox" checked={shapes} onChange={() => { onToggle('shapes'); }} />
          <span className="dg-check__label">Shape and equal-spacing snap</span>
        </label>
        <p className="dg-popover__hint">{hint ?? 'Grid visibility is separate. Hold Alt to move freely without guides.'}</p>
      </div>}
    </div>
    <select className="dg-grid-size" aria-label="Grid spacing" value={gridSize}
      title="Grid spacing" onChange={event => { onGridSize(diagramGridSize(Number(event.target.value))); }}>
      {[5, 10, 20, 40].map(value => <option key={value} value={value}>{value} units</option>)}
    </select>
  </>;
}

export function Swatches({ label, colours, value, onPick, exact = false }: {
  label: string; colours: readonly string[]; value: string | undefined; onPick: (c: string) => void; exact?: boolean;
}): React.ReactElement {
  const selected = colours.includes(value ?? '') ? value : exact ? undefined : colours.find(colour => value === diagramEditorFill(colour));
  return (
    <div className="dg-swatches">
      <span className="dg-swatches__label">{label}</span>
      <div className="dg-swatches__row" role="radiogroup" aria-label={label}>
        {colours.map((c) => (
          <button
            key={c} type="button" role="radio" aria-checked={selected === c} title={c === 'none' ? 'None' : `${IBM_COLOURS[c] ?? 'Colour'} (${c})`} aria-label={c === 'none' ? 'None' : c}
            aria-description={IBM_COLOURS[c]}
            className={`dg-swatch${c === 'none' ? ' dg-swatch--none' : ''}${selected === c ? ' dg-swatch--selected' : ''}`}
            style={c === 'none' ? undefined : { background: c }}
            onClick={() => { onPick(c); }}
          />
        ))}
      </div>
    </div>
  );
}

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
