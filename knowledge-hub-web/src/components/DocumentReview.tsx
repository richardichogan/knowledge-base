import React, { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { requireApiData, describeApiError } from '../services/apiError';
import { DocumentHtmlView } from './DocumentView';

export interface DocumentRevision { find: string; replacement: string; summary: string }

export const DocumentReview: React.FC<{
  source: string;
  version: string;
  matchMode?: 'text' | 'markdown';
  disabled?: boolean;
  onApply: (proposal: DocumentRevision) => void | Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  children: React.ReactNode;
}> = ({ source, version, matchMode = 'markdown', disabled = false, onApply, onPendingChange, children }) => {
  const body = useRef<HTMLDivElement>(null);
  const latest = useRef(version);
  latest.current = version;
  const [selection, setSelection] = useState('');
  const [selectionVersion, setSelectionVersion] = useState(version);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<(DocumentRevision & { version: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const pending = Boolean(selection && (instruction.trim() || proposal || busy));
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [pending]);
  const capture = (): void => {
    if (busy || proposal || disabled) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.anchorNode || !selected.focusNode
      || !body.current?.contains(selected.anchorNode) || !body.current.contains(selected.focusNode)) return;
    const text = selected.toString().trim();
    if (!text) return;
    setSelection(text); setSelectionVersion(version); setApplied(false); setError(null);
  };
  const discard = (): void => {
    setProposal(null); setSelection(''); setInstruction(''); setError(null);
  };
  const request = async (): Promise<void> => {
    setBusy(true); setError(null); setApplied(false);
    const snapshot = version;
    try {
      if (snapshot !== selectionVersion) throw new Error('The source changed after selection. Select the current passage and retry.');
      const result = requireApiData(await api.reviewDocument({ document: source, selection, instruction, matchMode }));
      if (latest.current !== snapshot) throw new Error('The source changed during review. Select the current passage and retry.');
      setProposal({ ...result, version: snapshot });
    } catch (failure) { setError(describeApiError(failure)); }
    finally { setBusy(false); }
  };
  const accept = async (): Promise<void> => {
    if (!proposal) return;
    setBusy(true); setError(null);
    try {
      if (latest.current !== proposal.version) throw new Error('The source changed. Discard this proposal and review the current text.');
      await onApply(proposal);
      discard(); setApplied(true);
    } catch (failure) { setError(describeApiError(failure)); }
    finally { setBusy(false); }
  };
  return <div className="kh-document-review">
    <p className="kh-document-view__hint">{disabled ? 'Editing is unavailable in the current state.' : 'Select text below, then ask Athena to propose a change. Nothing changes until you accept.'}</p>
    {selection && <section className="kh-document-review__controls" aria-label="Review selected passage">
      <h3>Selected passage</h3>
      <blockquote>{selection}</blockquote>
      {!proposal && <label className="kh-document-review__instruction">What should Athena change?
        <textarea value={instruction} maxLength={4000} rows={3} disabled={busy || disabled}
          onChange={event => { setInstruction(event.target.value); }} />
      </label>}
      {proposal && <div className="kh-document-review__proposal">
        <p>{proposal.summary}</p>
        <h4>Before</h4><pre>{proposal.find}</pre>
        <h4>Proposed result</h4>
        {proposal.replacement ? <DocumentHtmlView markdown={proposal.replacement} label="Proposed replacement" /> : <p>Remove selected text.</p>}
        <details><summary>Source Markdown</summary><pre>{proposal.replacement || '(Remove selected text)'}</pre></details>
      </div>}
      <div className="kh-document-review__actions">
        {proposal ? <button type="button" className="kh-btn-accent" disabled={busy || disabled} onClick={() => { void accept(); }}>Accept into source</button>
          : <button type="button" className="kh-btn-accent" disabled={busy || disabled || !instruction.trim() || selection.length > 8000 || source.length > 60000}
            onClick={() => { void request(); }}>{busy ? 'Athena is reviewing...' : 'Propose change'}</button>}
        <button type="button" className="kh-btn-ghost" disabled={busy} onClick={discard}>Discard</button>
      </div>
      <p className="kh-document-review__notice">Review feedback is temporary, not a requirement. Accept or copy it before leaving this document.</p>
      {(selection.length > 8000 || source.length > 60000) && <p role="alert" className="kh-document-view__error">Select a shorter passage; review supports up to 8,000 selected characters and 60,000 source characters.</p>}
    </section>}
    {error && <p role="alert" className="kh-document-view__error">{error}</p>}
    {applied && <p role="status" className="kh-document-view__hint">Accepted into the source document. Existing save controls still apply.</p>}
    <div ref={body} className="kh-document-review__document" tabIndex={0} role="region" aria-label="Select a passage for review" onMouseUp={capture} onKeyUp={capture}>{children}</div>
  </div>;
};
