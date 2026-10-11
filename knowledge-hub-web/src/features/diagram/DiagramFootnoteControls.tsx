import React from 'react';
import { ArrowUp, ArrowDown, Link, TrashCan } from '@carbon/icons-react';
import type { DiagramDocument } from './diagramTypes';
import { footnoteHref, footnotesOf, moveFootnote, removeFootnote } from './diagramAnnotations';

const seg = (on: boolean): string => `dg-segment__option${on ? ' dg-segment__option--selected' : ''}`;

export interface FootnoteControlsProps {
  canvasId: string;
  doc: DiagramDocument;
  footnoteId: string;
  /** `history` true starts a new undo step. */
  onChange: (next: DiagramDocument, history: boolean) => void;
  onCopied: (message: string) => void;
}

/** Properties-panel controls for the selected element's footnote. The note text is the element's description. */
export function DiagramFootnoteControls({ canvasId, doc, footnoteId, onChange, onCopied }: FootnoteControlsProps): React.ReactElement | null {
  const list = footnotesOf(doc);
  const i = list.findIndex((f) => f.id === footnoteId);
  if (i < 0) return null;
  const n = i + 1;
  const position = doc.notesPanel ?? 'bottom';

  async function copyLink(): Promise<void> {
    const url = new URL(footnoteHref(canvasId, n), window.location.origin).toString();
    try { await navigator.clipboard.writeText(url); onCopied(`Link to footnote ${n} copied.`); }
    catch { onCopied(url); }
  }

  return <section className="dg-footnote-controls" aria-label={`Footnote ${n}`}>
    <h4>Footnote {n}</h4>
    <p className="dg-footnote-controls__hint">The note on the diagram shows this item's description.</p>
    <div className="dg-footnote-controls__row">
      <div className="dg-segment" role="group" aria-label="Notes position">
        <button type="button" className={seg(position === 'bottom')} aria-pressed={position === 'bottom'} onClick={() => { onChange({ ...doc, notesPanel: 'bottom' }, true); }}>Notes below</button>
        <button type="button" className={seg(position === 'right')} aria-pressed={position === 'right'} onClick={() => { onChange({ ...doc, notesPanel: 'right' }, true); }}>Notes right</button>
      </div>
    </div>
    <div className="dg-footnote-controls__row">
      <button type="button" className="dg-btn" aria-label={`Move footnote ${n} up`} title="Move up" disabled={i === 0}
        onClick={() => { onChange(moveFootnote(doc, footnoteId, -1), true); }}><ArrowUp size={16} /></button>
      <button type="button" className="dg-btn" aria-label={`Move footnote ${n} down`} title="Move down" disabled={i === list.length - 1}
        onClick={() => { onChange(moveFootnote(doc, footnoteId, 1), true); }}><ArrowDown size={16} /></button>
      <button type="button" className="dg-btn" aria-label={`Copy link to footnote ${n}`} title="Copy link"
        onClick={() => { void copyLink(); }}><Link size={16} /></button>
      <button type="button" className="dg-btn" aria-label={`Remove footnote ${n}`} title="Remove footnote"
        onClick={() => { onChange(removeFootnote(doc, footnoteId), true); }}><TrashCan size={16} /></button>
    </div>
  </section>;
}
