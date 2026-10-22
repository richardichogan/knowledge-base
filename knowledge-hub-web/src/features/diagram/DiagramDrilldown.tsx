import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Close, Layers } from '@carbon/icons-react';
import { DiagramEditor } from './DiagramEditor';
import type { AthenaPageContext } from '../../context/AthenaContext';

/** A separate editable canvas; the parent stays mounted with its selection and viewport intact. */
export function DiagramDrilldown({ canvasId, shapeTitle, parentTitle, parentContext, onClose, onOpenNote }: {
  canvasId: string;
  shapeTitle: string;
  parentTitle: string;
  parentContext?: AthenaPageContext | undefined;
  onClose: () => void;
  onOpenNote?: ((id: string) => void) | undefined;
}): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const saveChild = useRef<(() => Promise<boolean>) | null>(null);
  const closing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const registerSave = useCallback((save: (() => Promise<boolean>) | null) => { saveChild.current = save; }, []);
  useEffect(() => {
    const element = dialog.current!;
    const focused = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);

  async function close(afterClose?: () => void): Promise<void> {
    if (closing.current) return;
    closing.current = true;
    setBusy(true);
    setError(null);
    try {
      if (saveChild.current !== null && !await saveChild.current()) {
        throw new Error('Your detail diagram has unsaved changes. Use Retry or resolve the save conflict in the diagram before returning.');
      }
      onClose();
      afterClose?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the detail diagram. Your changes remain open.');
    } finally { closing.current = false; setBusy(false); }
  }
  return createPortal(
    <dialog ref={dialog} className="dg-drilldown" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); void close(); }}
      onKeyDown={event => { event.stopPropagation(); }}
      onKeyUp={event => { event.stopPropagation(); }}
      onCopy={event => { event.stopPropagation(); }}
      onCut={event => { event.stopPropagation(); }}
      onPaste={event => { event.stopPropagation(); }}>
      <header className="dg-drilldown__header">
        <div className="dg-drilldown__context">
          <Layers size={24} />
          <div><h2 id={titleId} title={shapeTitle}>{shapeTitle}</h2><p title={`Inside ${parentTitle}`}>Inside {parentTitle}</p></div>
        </div>
        <button type="button" className="dg-text-btn" autoFocus disabled={busy} onClick={() => { void close(); }}>
          <ChevronLeft size={16} /> {busy ? 'Saving…' : 'Back to parent'}
        </button>
        <button type="button" className="dg-btn" aria-label="Close drill-down" disabled={busy}
          onClick={() => { void close(); }}><Close size={20} /></button>
      </header>
      {error !== null && <p className="dg-drilldown__error" role="alert">{error}</p>}
      <div className="dg-drilldown__body">
        <DiagramEditor canvasId={canvasId} parentContext={parentContext} onSaveReady={registerSave} onDeleted={onClose}
          onOpenNote={onOpenNote === undefined ? undefined : id => { void close(() => { onOpenNote(id); }); }} />
      </div>
    </dialog>, document.body);
}
