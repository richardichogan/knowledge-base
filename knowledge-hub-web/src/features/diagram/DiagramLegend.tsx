import React, { useRef, useState } from 'react';
import { Close, Settings, View, ViewOff } from '@carbon/icons-react';
import type { DiagramDocument, DiagramLegendPosition } from './diagramTypes';
import { legendRows, setLegend, setLegendEntry } from './diagramAnnotations';

const POSITIONS: Array<[DiagramLegendPosition, string]> = [
  ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right'],
];

/** Colour key built from shape border colours. Clicking a colour highlights the shapes that use it. */
export function DiagramLegend({ doc, filter, onFilter, onChange, readOnly = false }: {
  doc: DiagramDocument;
  filter: string | null;
  onFilter: (colour: string | null) => void;
  onChange: (next: DiagramDocument, history: boolean) => void;
  readOnly?: boolean;
}): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const typing = useRef<string | null>(null);
  const legend = doc.legend;
  if (legend === undefined || !legend.visible) return null;
  const rows = legendRows(doc);
  const shown = editing ? rows : rows.filter((r) => !r.hidden);
  return <div className={`dg-legend dg-legend--${legend.position}${editing ? ' dg-legend--editing' : ''}`} role="region" aria-label="Colour key"
    onPointerDown={(e) => { e.stopPropagation(); }} onDoubleClick={(e) => { e.stopPropagation(); }}>
    <div className="dg-legend__head">
      <h3>Key</h3>
      {!readOnly && <>
        <button type="button" className="dg-btn dg-legend__btn" aria-pressed={editing} aria-label={editing ? 'Done editing key' : 'Edit key'} title={editing ? 'Done' : 'Edit key'}
          onClick={() => { setEditing(!editing); typing.current = null; }}><Settings size={14} /></button>
        <button type="button" className="dg-btn dg-legend__btn" aria-label="Hide key" title="Hide key"
          onClick={() => { onFilter(null); onChange(setLegend(doc, { visible: false }), true); }}><Close size={14} /></button>
      </>}
    </div>
    {rows.length === 0 && <p className="dg-legend__empty">Give shapes a border colour to build a key.</p>}
    <ul className="dg-legend__list">
      {shown.map((r) => {
        const label = r.label.trim() !== '' ? r.label : r.colour;
        return <li key={r.colour} className={`dg-legend__row${filter === r.colour ? ' dg-legend__row--active' : ''}${r.hidden ? ' dg-legend__row--hidden' : ''}`}>
          {editing
            ? <>
                <span className="dg-legend__swatch" style={{ borderColor: r.colour }} aria-hidden />
                <input aria-label={`Meaning of ${r.colour}`} placeholder={`What ${r.colour} means`} maxLength={120} spellCheck value={r.label}
                  onChange={(e) => {
                    const first = typing.current !== r.colour;
                    typing.current = r.colour;
                    onChange(setLegendEntry(doc, r.colour, { label: e.target.value }), first);
                  }} />
                <button type="button" className="dg-btn dg-legend__btn" aria-label={r.hidden ? `Show ${label} in key` : `Hide ${label} from key`} title={r.hidden ? 'Show in key' : 'Hide from key'}
                  onClick={() => { onChange(setLegendEntry(doc, r.colour, { hidden: !r.hidden }), true); }}>{r.hidden ? <ViewOff size={14} /> : <View size={14} />}</button>
              </>
            : <button type="button" className="dg-legend__item" aria-pressed={filter === r.colour}
                title={filter === r.colour ? 'Show all shapes' : `Highlight the ${r.count} shape${r.count === 1 ? '' : 's'} with this colour`}
                onClick={() => { onFilter(filter === r.colour ? null : r.colour); }}>
                <span className="dg-legend__swatch" style={{ borderColor: r.colour }} aria-hidden />
                <span className={`dg-legend__label${r.label.trim() === '' ? ' dg-legend__label--placeholder' : ''}`}>{r.label.trim() !== '' ? r.label : 'Unlabelled'}</span>
              </button>}
        </li>;
      })}
    </ul>
    {editing && <label className="dg-legend__position">Position
      <select value={legend.position} onChange={(e) => { onChange(setLegend(doc, { position: e.target.value as DiagramLegendPosition }), true); }}>
        {POSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>}
  </div>;
}
