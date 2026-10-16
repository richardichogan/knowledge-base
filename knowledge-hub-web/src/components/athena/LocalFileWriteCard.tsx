/**
 * components/athena/LocalFileWriteCard.tsx — a change Athena proposed to a file
 * on this PC (Athena Desktop). Shows the diff against the file as it is now and
 * writes it only when Apply is clicked; nothing is written otherwise.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { LocalFileWrite } from '../../types';
import { desktopErrorMessage, getDesktop } from '../../types/desktop';
import { diffLines, type DiffLine } from '../../utils/lineDiff';

type Status = 'loading' | 'pending' | 'applying' | 'applied' | 'discarded' | 'failed';

const CONTEXT_LINES = 3;

/** Unchanged runs longer than the context are folded to "… n unchanged lines". */
function foldDiff(lines: DiffLine[]): Array<DiffLine | { type: 'fold'; count: number }> {
  const out: Array<DiffLine | { type: 'fold'; count: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.type !== 'same') { out.push(lines[i]!); i += 1; continue; }
    let j = i;
    while (j < lines.length && lines[j]!.type === 'same') j += 1;
    const run = lines.slice(i, j);
    const keepStart = i === 0 ? 0 : CONTEXT_LINES;
    const keepEnd = j === lines.length ? 0 : CONTEXT_LINES;
    if (run.length > keepStart + keepEnd + 1) {
      out.push(...run.slice(0, keepStart), { type: 'fold', count: run.length - keepStart - keepEnd }, ...run.slice(run.length - keepEnd));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

const FileWrite: React.FC<{ write: LocalFileWrite }> = ({ write }) => {
  const desktop = getDesktop();
  const [status, setStatus] = useState<Status>(desktop === null ? 'pending' : 'loading');
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<string | null> => {
    if (desktop === null) return null;
    const text = await desktop.readText(write.path);
    setCurrent(text);
    return text;
  }, [desktop, write.path]);

  useEffect(() => {
    if (desktop === null) return;
    load().then(() => { setStatus('pending'); }).catch((err: unknown) => {
      setError(desktopErrorMessage(err));
      setStatus('failed');
    });
  }, [desktop, load]);

  const diff = useMemo(() => (current === null ? null : foldDiff(diffLines(current, write.content))), [current, write.content]);
  const unchanged = current !== null && current === write.content;

  async function apply(): Promise<void> {
    if (desktop === null) return;
    setStatus('applying');
    setError('');
    try {
      const now = await desktop.readText(write.path);
      if (now !== current) {
        // Edited on the PC since the diff was shown: show the real diff before writing anything.
        setCurrent(now);
        setError('The file changed on your PC since this was shown. Check the updated diff, then apply again.');
        setStatus('failed');
        return;
      }
      await desktop.writeText(write.path, write.content);
      setStatus('applied');
    } catch (err) {
      setError(desktopErrorMessage(err));
      setStatus('failed');
    }
  }

  const tone = status === 'applied' ? 'applied' : status === 'discarded' ? 'discarded' : 'pending';
  return (
    <li className={`local-write local-write--${tone}`}>
      <div className="local-write__head">
        <code className="local-write__path" title={write.path}>{write.path}</code>
        {current === null && status !== 'loading' && desktop !== null && <span className="local-write__tag">New file</span>}
        {status === 'applied' && <span className="note-edit-card__done">Written</span>}
        {status === 'discarded' && <span className="note-edit-card__done">Discarded</span>}
      </div>
      <p className="note-edit-card__summary">{write.summary}</p>
      {desktop === null && <p className="note-edit-card__failed">Open Athena Desktop on the PC with this file to review and apply it.</p>}
      {status === 'loading' && <p className="local-write__loading">Reading the file…</p>}
      {desktop !== null && status !== 'loading' && status !== 'discarded' && (
        unchanged ? <p className="local-write__loading">The file already has this content.</p> : (
          <pre className="ai-diff local-write__diff" aria-label={`Changes to ${write.path}`}>
            {(diff ?? write.content.split('\n').map((text) => ({ type: 'added' as const, text }))).map((l, i) => (
              l.type === 'fold'
                ? <div key={i} className="ai-diff__line local-write__fold">… {l.count.toString()} unchanged line{l.count === 1 ? '' : 's'}</div>
                : (
                  <div key={i} className={`ai-diff__line ai-diff__line--${l.type}`}>
                    <span className="ai-diff__mark" aria-hidden="true">{l.type === 'added' ? '+' : l.type === 'removed' ? '−' : ' '}</span>
                    {l.text === '' ? ' ' : l.text}
                  </div>
                )
            ))}
          </pre>
        )
      )}
      {status === 'failed' && error !== '' && <p className="note-edit-card__failed">{error}</p>}
      {desktop !== null && (status === 'pending' || status === 'failed' || status === 'applying') && !unchanged && (
        <div className="note-edit-card__actions">
          <button type="button" className="ai-feedback__action" disabled={status === 'applying'} onClick={() => { void apply(); }}>
            {status === 'applying' ? 'Writing…' : current === null ? 'Create file' : 'Apply'}
          </button>
          <button type="button" className="ai-feedback__action ai-feedback__action--quiet" onClick={() => { setStatus('discarded'); }}>Discard</button>
        </div>
      )}
      {status === 'applied' && desktop !== null && (
        <div className="note-edit-card__actions">
          <button type="button" className="ai-feedback__action ai-feedback__action--quiet" onClick={() => { void desktop.showInFolder(write.path).catch((err: unknown) => { setError(desktopErrorMessage(err)); }); }}>
            Show in folder
          </button>
        </div>
      )}
    </li>
  );
};

export const LocalFileWriteCard: React.FC<{ writes: LocalFileWrite[] }> = ({ writes }) => (
  <div className="note-edit-card note-edit-card--pending local-write-card">
    <div className="note-edit-card__head">
      <span className="note-edit-card__title">Proposed change{writes.length === 1 ? '' : 's'} to file{writes.length === 1 ? '' : 's'} on your PC</span>
    </div>
    <ol className="local-write__list">
      {writes.map((w, i) => <FileWrite key={`${w.path}-${i.toString()}`} write={w} />)}
    </ol>
  </div>
);
