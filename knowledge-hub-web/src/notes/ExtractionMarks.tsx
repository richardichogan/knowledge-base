/**
 * Marks passages of a note that have been turned into something (Spark, task,
 * canvas node, new note, Athena chat). Uses the CSS Custom Highlight API, so the
 * note content itself is never modified. Clicking a marked passage shows what
 * was done with it and links to each target.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Close } from '@carbon/icons-react';
import { api } from '../services/api';
import type { NoteExtraction, NoteExtractionAction } from '../services/api';

const HIGHLIGHT_NAME = 'kh-extracted';
const ACTION_LABEL: Record<NoteExtractionAction, string> = {
  spark: 'Spark', task: 'Task', canvas: 'Canvas', note: 'New note', athena: 'Athena',
};

function targetPath(x: NoteExtraction): string | null {
  switch (x.action) {
    case 'spark': return '/think?view=sparks';
    case 'canvas': return x.targetId ? `/think?mapId=${x.targetId}` : null;
    case 'note': return x.targetId ? `/think?noteId=${x.targetId}` : null;
    case 'task': return '/plan';
    default: return null;
  }
}

const norm = (t: string): string => t.replace(/\u00a0/g, ' ');

interface Marked { range: Range; extraction: NoteExtraction }

function findRanges(root: HTMLElement, extractions: NoteExtraction[]): Marked[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let flat = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(flat.length);
    flat += norm((n as Text).data);
  }
  const locate = (pos: number): { node: Text; offset: number } | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (pos >= starts[i]!) return { node: nodes[i]!, offset: pos - starts[i]! };
    }
    return null;
  };
  const out: Marked[] = [];
  for (const extraction of extractions) {
    for (const segment of extraction.quote.split('\n').map((s) => norm(s).trim()).filter((s) => s.length >= 3)) {
      const at = flat.indexOf(segment);
      if (at < 0) continue;
      const a = locate(at);
      const b = locate(at + segment.length - 1);
      if (!a || !b) continue;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, Math.min(b.offset + 1, b.node.data.length));
      out.push({ range, extraction });
    }
  }
  return out;
}

export const ExtractionMarks: React.FC<{ noteId: string; scrollRef: React.RefObject<HTMLDivElement | null> }> = ({ noteId, scrollRef }) => {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const marked = useRef<Marked[]>([]);
  const [popover, setPopover] = useState<{ x: number; y: number; items: NoteExtraction[] } | null>(null);

  const { data: extractions = [] } = useQuery({
    queryKey: ['note-extractions', noteId],
    queryFn: async () => {
      const res = await api.listNoteExtractions(noteId);
      return res.success ? res.data : [];
    },
    staleTime: 30_000,
  });

  const apply = useCallback(() => {
    const root = scrollRef.current;
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (!root || !registry || typeof Highlight === 'undefined') return;
    marked.current = findRanges(root, extractions);
    if (marked.current.length === 0) { registry.delete(HIGHLIGHT_NAME); return; }
    registry.set(HIGHLIGHT_NAME, new Highlight(...marked.current.map((m) => m.range)));
  }, [extractions, scrollRef]);

  useEffect(() => {
    apply();
    const root = scrollRef.current;
    if (!root || extractions.length === 0) return;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(apply, 400);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(HIGHLIGHT_NAME);
    };
  }, [apply, extractions.length, scrollRef]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent): void => {
      if (window.getSelection()?.toString()) return;
      const hit = marked.current.filter((m) => {
        for (const r of Array.from(m.range.getClientRects())) {
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return true;
        }
        return false;
      });
      if (hit.length === 0) { setPopover(null); return; }
      const unique = [...new Map(hit.map((m) => [m.extraction.id, m.extraction])).values()];
      setPopover({ x: e.clientX, y: e.clientY, items: unique });
    };
    root.addEventListener('click', onClick);
    return () => { root.removeEventListener('click', onClick); };
  }, [scrollRef]);

  useEffect(() => {
    if (!popover) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.extraction-pop')) setPopover(null);
    };
    document.addEventListener('mousedown', close);
    return () => { document.removeEventListener('mousedown', close); };
  }, [popover]);

  if (!popover) return null;
  const remove = async (id: string): Promise<void> => {
    await api.deleteNoteExtraction(noteId, id);
    setPopover(null);
    void qc.invalidateQueries({ queryKey: ['note-extractions', noteId] });
  };
  return (
    <div className="extraction-pop" style={{ left: popover.x, top: popover.y + 14 }} role="dialog" aria-label="What was done with this text">
      <div className="extraction-pop__title">Used from this text</div>
      {popover.items.map((x) => {
        const to = targetPath(x);
        return (
          <div key={x.id} className="extraction-pop__row">
            <span className="extraction-pop__action">{ACTION_LABEL[x.action]}</span>
            <span className="extraction-pop__label">{x.targetLabel || ACTION_LABEL[x.action]}</span>
            {to && <button type="button" onClick={() => { navigate(to); setPopover(null); }}>Open <ArrowRight size={12} /></button>}
            <button type="button" className="extraction-pop__remove" aria-label="Remove marker" title="Remove marker" onClick={() => { void remove(x.id); }}><Close size={12} /></button>
          </div>
        );
      })}
    </div>
  );
};
