/**
 * Marks passages of a note that have been turned into something (Spark, task,
 * canvas node, new note, Athena chat) with a margin bar beside the passage, so the
 * note content itself is never modified. Clicking the bar (or the passage) shows
 * what was done with it and links to each target.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CarbonIconType } from '@carbon/icons-react';
import { ArrowRight, Close, Idea, TaskAdd, Diagram, DocumentAdd, ChatBot } from '@carbon/icons-react';
import { api } from '../services/api';
import type { NoteExtraction, NoteExtractionAction } from '../services/api';

interface Bar { key: string; top: number; height: number; left: number; items: NoteExtraction[] }
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

const ACTION_ICON: Record<NoteExtractionAction, CarbonIconType> = {
  spark: Idea, task: TaskAdd, canvas: Diagram, note: DocumentAdd, athena: ChatBot,
};
const ACTION_VERB: Record<NoteExtractionAction, string> = {
  spark: 'Saved as a Spark', task: 'Turned into a task', canvas: 'Added to canvas',
  note: 'Extracted to a new note', athena: 'Discussed with Athena',
};

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
  const [bars, setBars] = useState<Bar[]>([]);
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
    if (!root) return;
    marked.current = findRanges(root, extractions);
    const rootRect = root.getBoundingClientRect();
    const innerRect = (root.querySelector('.notes-editor-inner') ?? root).getBoundingClientRect();
    const left = Math.round(innerRect.right - rootRect.left + root.scrollLeft + 6);
    const byExtraction = new Map<string, Bar>();
    for (const m of marked.current) {
      const r = m.range.getBoundingClientRect();
      if (r.height === 0) continue;
      const top = r.top - rootRect.top + root.scrollTop;
      const prev = byExtraction.get(m.extraction.id);
      if (prev) {
        const bottom = Math.max(prev.top + prev.height, top + r.height);
        prev.top = Math.min(prev.top, top);
        prev.height = bottom - prev.top;
      } else {
        byExtraction.set(m.extraction.id, { key: m.extraction.id, top, height: r.height, left, items: [m.extraction] });
      }
    }
    const next = [...byExtraction.values()].map((x) => ({ ...x, top: Math.round(x.top), height: Math.round(x.height) }));
    setBars((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }, [extractions, scrollRef]);

  useEffect(() => {
    apply();
    const root = scrollRef.current;
    if (!root || extractions.length === 0) return;
    let timer: number | undefined;
    const schedule = (): void => { window.clearTimeout(timer); timer = window.setTimeout(apply, 300); };
    const observer = new MutationObserver((records) => {
      if (records.every((r) => (r.target as HTMLElement).closest?.('.extraction-bar') !== null)) return;
      schedule();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.clearTimeout(timer);
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

  const remove = async (id: string): Promise<void> => {
    await api.deleteNoteExtraction(noteId, id);
    setPopover(null);
    void qc.invalidateQueries({ queryKey: ['note-extractions', noteId] });
  };
  const root = scrollRef.current;
  const barLayer = root ? createPortal(
    <>
      {bars.map((b) => {
        const x = b.items[0]!;
        const Icon = ACTION_ICON[x.action];
        const tip = x.action === 'athena' ? ACTION_VERB.athena : `${ACTION_VERB[x.action]}: ${x.targetLabel}`;
        return (
          <div key={b.key} className="extraction-bar" style={{ top: b.top, height: Math.max(b.height, 24), left: b.left }}>
            <button type="button" className="extraction-bar__icon" data-tip={`${tip}. Click for details.`}
              aria-label={tip}
              onClick={(e) => { e.stopPropagation(); setPopover({ x: e.clientX - 220, y: e.clientY, items: b.items }); }}>
              <Icon size={12} />
            </button>
          </div>
        );
      })}
    </>, root) : null;
  if (!popover) return barLayer;
  return (
    <>
    {barLayer}
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
    </>
  );
};
