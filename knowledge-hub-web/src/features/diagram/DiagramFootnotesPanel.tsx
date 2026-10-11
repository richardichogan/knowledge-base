import React, { useEffect, useRef } from 'react';
import { ArrowUp, ArrowDown, Link, TrashCan, Close } from '@carbon/icons-react';
import type { DiagramDocument } from './diagramTypes';
import { elementInfo, footnoteHref, footnoteText, footnotesOf, moveFootnote, removeFootnote, updateFootnote } from './diagramAnnotations';
import { DiagramElementNotes } from './DiagramElementNotes';

const seg = (on: boolean): string => `dg-segment__option${on ? ' dg-segment__option--selected' : ''}`;

export interface FootnotePanelProps {
  canvasId: string;
  doc: DiagramDocument;
  /** Footnote id currently highlighted (from a marker click, the selection, or a deep link). */
  activeId: string | null;
  position: 'bottom' | 'right';
  elementNotes: ReadonlyArray<{ elementId: string; noteId: string; title: string }>;
  /** `history` true starts a new undo step; false updates the current one (typing). */
  onChange: (next: DiagramDocument, history: boolean) => void;
  onSelectTarget: (targetId: string, footnoteId: string) => void;
  onPosition: (position: 'bottom' | 'right') => void;
  onHide: () => void;
  onOpenNote?: ((id: string) => void) | undefined;
  beforeLink: () => Promise<boolean>;
  onCopied: (message: string) => void;
}

export function DiagramFootnotesPanel(props: FootnotePanelProps): React.ReactElement {
  const { canvasId, doc, activeId, position, elementNotes, onChange, onSelectTarget } = props;
  const list = footnotesOf(doc);
  const listRef = useRef<HTMLOListElement>(null);
  const typing = useRef<string | null>(null);

  useEffect(() => {
    if (activeId === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-footnote-id="${activeId}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  async function copyLink(n: number): Promise<void> {
    const url = new URL(footnoteHref(canvasId, n), window.location.origin).toString();
    try { await navigator.clipboard.writeText(url); props.onCopied(`Link to footnote ${n} copied.`); }
    catch { props.onCopied(url); }
  }

  return <aside className={`dg-footnotes dg-footnotes--${position}`} aria-label="Diagram footnotes">
    <header className="dg-footnotes__head">
      <h3>Notes</h3>
      <div className="dg-footnotes__tools">
        <div className="dg-segment" role="group" aria-label="Notes position">
          <button type="button" className={seg(position === 'bottom')} aria-pressed={position === 'bottom'} onClick={() => { props.onPosition('bottom'); }}>Bottom</button>
          <button type="button" className={seg(position === 'right')} aria-pressed={position === 'right'} onClick={() => { props.onPosition('right'); }}>Right</button>
        </div>
        <button type="button" className="dg-btn" aria-label="Hide notes" title="Hide notes" onClick={props.onHide}><Close size={16} /></button>
      </div>
    </header>
    <ol className="dg-footnotes__list" ref={listRef}>
      {list.map((fn, i) => {
        const n = i + 1;
        const info = elementInfo(doc, fn.targetId);
        const links = elementNotes.filter((l) => l.elementId === fn.targetId || l.elementId === fn.id);
        const hasDescription = (info?.description ?? '').trim() !== '';
        return <li key={fn.id} id={`dg-footnote-${n}`} data-footnote-id={fn.id}
          className={`dg-footnote${activeId === fn.id ? ' dg-footnote--active' : ''}`}>
          <a className="dg-footnote__num" href={footnoteHref(canvasId, n)} aria-label={`Footnote ${n}: show on diagram`}
            onClick={(e) => { e.preventDefault(); onSelectTarget(fn.targetId, fn.id); }}>{n}</a>
          <div className="dg-footnote__body">
            <div className="dg-footnote__title">
              <button type="button" className="dg-footnote__target" onClick={() => { onSelectTarget(fn.targetId, fn.id); }}>
                {info?.label ?? 'Missing item'}
              </button>
              <span className="dg-footnote__kind">{info?.kind === 'connector' ? 'Connector' : 'Shape'}</span>
            </div>
            <div className="dg-segment dg-segment--compact" role="group" aria-label={`Footnote ${n} text`}>
              <button type="button" className={seg(fn.source === 'description')} aria-pressed={fn.source === 'description'} onClick={() => { onChange(updateFootnote(doc, fn.id, { source: 'description' }), true); }}>Description</button>
              <button type="button" className={seg(fn.source === 'custom')} aria-pressed={fn.source === 'custom'} onClick={() => { onChange(updateFootnote(doc, fn.id, { source: 'custom', text: fn.text ?? footnoteText(doc, fn) }), true); }}>Custom text</button>
            </div>
            {fn.source === 'description'
              ? <p className={`dg-footnote__text${hasDescription ? '' : ' dg-footnote__text--empty'}`}>
                  {hasDescription ? info?.description : 'No description yet — add one in Properties, or switch to custom text.'}
                </p>
              : <textarea className="dg-footnote__input" aria-label={`Footnote ${n} custom text`} rows={3} maxLength={10000} spellCheck
                  placeholder="Describe this part of the diagram" value={fn.text ?? ''}
                  onFocus={() => { typing.current = null; }}
                  onChange={(e) => {
                    const first = typing.current !== fn.id;
                    typing.current = fn.id;
                    onChange(updateFootnote(doc, fn.id, { text: e.target.value }), first);
                  }} />}
            <DiagramElementNotes compact canvasId={canvasId} elementId={fn.targetId} title={`Notes for footnote ${n}`}
              notes={links} onOpenNote={props.onOpenNote} beforeChange={props.beforeLink} />
          </div>
          <div className="dg-footnote__actions">
            <button type="button" className="dg-btn" aria-label={`Move footnote ${n} up`} title="Move up" disabled={i === 0}
              onClick={() => { onChange(moveFootnote(doc, fn.id, -1), true); }}><ArrowUp size={14} /></button>
            <button type="button" className="dg-btn" aria-label={`Move footnote ${n} down`} title="Move down" disabled={i === list.length - 1}
              onClick={() => { onChange(moveFootnote(doc, fn.id, 1), true); }}><ArrowDown size={14} /></button>
            <button type="button" className="dg-btn" aria-label={`Copy link to footnote ${n}`} title="Copy link"
              onClick={() => { void copyLink(n); }}><Link size={14} /></button>
            <button type="button" className="dg-btn" aria-label={`Remove footnote ${n}`} title="Remove footnote"
              onClick={() => { onChange(removeFootnote(doc, fn.id), true); }}><TrashCan size={14} /></button>
          </div>
        </li>;
      })}
    </ol>
  </aside>;
}
