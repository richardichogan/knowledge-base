/**
 * GlobalContextMenu — app-wide right-click menu.
 *
 * Triggers on ANY right-click. Priority:
 *  1. Element with data-ctx-title → structured item
 *  2. <img> element               → image node
 *  3. Text selection              → text node
 *  4. <a href> ancestor           → link node
 *  5. Passthrough to browser
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Checkmark, Diagram, Link, Copy, TaskAdd, Idea, DocumentAdd, ChatBot, ArrowRight } from '@carbon/icons-react';
import { useAthenaContext } from './AthenaContext';
import { createNote } from '../notes/noteStorage';
import type { NoteExtractionAction } from '../services/api';
import { api } from '../services/api';
import type { CanvasSummaryApi } from '../services/api';
import { extractTasksWithAI } from '../utils/aiTaskExtraction';
import { addWorkingDays, toISODateString } from '../utils/dates';
import { getActiveBlockNoteSelectedText, clearActiveBlockNoteSelectionSnapshot, suspendBlockNoteSelectionCapture, resumeBlockNoteSelectionCapture, hasBlockNoteCellSelection } from '../utils/activeBlockNoteEditor';

export interface CtxItemData {
  title: string;
  body?: string | undefined;
  source?: string | undefined;
  url?: string | undefined;
  imageUrl?: string | undefined;
  nodeType?: string | undefined;
  refId?: string | undefined;
  refType?: string | undefined;
  tags?: string[] | undefined;
  taxonomyTagIds?: string[] | undefined;
  /** True when `body` is text the user selected (as opposed to a card's summary). */
  fromSelection?: boolean | undefined;
  /** Selection made inside an Athena chat (no Discuss action there). */
  fromChat?: boolean | undefined;
}

interface MenuState { x: number; y: number; item: CtxItemData; }
interface GlobalCtxMenuCtx { openMenu: (e: MouseEvent | React.MouseEvent, item: CtxItemData) => void; }

const Ctx = createContext<GlobalCtxMenuCtx>({ openMenu: () => {} });

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export function useGlobalContextMenu() { return useContext(Ctx); }

export function GlobalContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Browsers collapse the current selection if a right-click lands outside its
  // bounds, *before* the 'contextmenu' event fires — losing the text the user
  // meant to act on. Capture the selection on mousedown (capture phase, which
  // runs before that collapse) so we can fall back to it.
  const lastMouseDownSelection = useRef<string>('');
  // Right-clicks left to the browser: in editable text with nothing selected
  // (so spell-check suggestions work), or with Shift held.
  const nativeMenuForThisClick = useRef(false);

  const openMenu = useCallback((e: MouseEvent | React.MouseEvent, item: CtxItemData) => {
    e.preventDefault();
    setMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, item });
  }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      // A right-click: the right button, or Ctrl+click on a Mac.
      if (e.button === 2 || (e.button === 0 && e.ctrlKey && IS_MAC)) {
        const sel = window.getSelection()?.toString().trim() ?? '';
        const inEditable = (e.target as HTMLElement | null)?.closest('[contenteditable="true"], input, textarea') != null;
        // What is visibly selected right now (the editor's own state can lag a
        // click behind, and it remembers old selections).
        const hasSelection = sel.length > 2 || hasBlockNoteCellSelection();
        nativeMenuForThisClick.current = e.shiftKey || (inEditable && !hasSelection);
        // Let the browser place the caret on the word under the cursor, which is
        // what its context menu needs to offer spelling corrections.
        if (nativeMenuForThisClick.current) return;
        lastMouseDownSelection.current = sel;
        // Freeze the BlockNote selection snapshot right now, before the
        // browser's native "select word under cursor to build its context
        // menu" behavior can run. That native behavior happens between
        // mousedown and the contextmenu event and isn't something JS can
        // prevent — but if we stop *our own* snapshot from listening to any
        // selectionchange it triggers, the real (multi-row) selection the
        // user made a moment earlier survives intact.
        suspendBlockNoteSelectionCapture();
        // Stop the event dead here (capture phase, before it reaches the
        // target). This prevents BOTH the browser's default "collapse
        // selection to click point" behavior AND any rich-text editor
        // (ProseMirror/BlockNote) from seeing the mousedown and repositioning
        // or collapsing its own internal selection (e.g. a table
        // CellSelection) in response to the right-click.
        e.preventDefault();
        e.stopPropagation();
      } else {
        // A fresh left-click/drag is starting a new selection — resume
        // tracking so the next right-click has an up-to-date snapshot.
        resumeBlockNoteSelectionCapture();
      }
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, []);

  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      if (nativeMenuForThisClick.current || e.shiftKey) { nativeMenuForThisClick.current = false; return; }
      const target = e.target as HTMLElement;
      const liveSel = window.getSelection()?.toString().trim() ?? '';
      // BlockNote/ProseMirror table cell-range selections don't populate the
      // native browser Selection object correctly — ask the editor directly
      // first (covers both plain text and table selections in notes).
      const editorSel = getActiveBlockNoteSelectedText();
      const inChatArea = target.closest('.ai-messages') !== null;
      const sel = inChatArea && liveSel.length > 2 ? liveSel
        : editorSel.length > 2 ? editorSel
        : liveSel.length > 2 ? liveSel
        : lastMouseDownSelection.current;

      // 1. Walk DOM for data-ctx-title
      let el: HTMLElement | null = target;
      let ctxTitle: string | null = null;
      while (el && !ctxTitle) {
        ctxTitle = el.getAttribute('data-ctx-title');
        if (!ctxTitle) el = el.parentElement;
      }
      if (ctxTitle && el) {
        e.preventDefault();
        // If user has selected text inside this element, that selection is the body.
        // The element's title/url/ref become the source context.
        const body = sel.length > 2 ? sel : (el.getAttribute('data-ctx-body') ?? undefined);
        const rawTags = el.getAttribute('data-ctx-tags');
        const tags = rawTags ? rawTags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
        const rawTagIds = el.getAttribute('data-ctx-tag-ids');
        const taxonomyTagIds = rawTagIds ? rawTagIds.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
        setMenu({
          x: e.clientX, y: e.clientY,
          item: {
            title:   ctxTitle,
            ...(body                                  ? { body                                         } : {}),
            ...(sel.length > 2                        ? { fromSelection: true                          } : {}),
            ...(el.getAttribute('data-ctx-source')   ? { source:  el.getAttribute('data-ctx-source')! } : {}),
            ...(el.getAttribute('data-ctx-url')      ? { url:     el.getAttribute('data-ctx-url')!    } : {}),
            ...(el.getAttribute('data-ctx-ref-id')   ? { refId:   el.getAttribute('data-ctx-ref-id')! } : {}),
            ...(el.getAttribute('data-ctx-ref-type') ? { refType: el.getAttribute('data-ctx-ref-type')!} : {}),
            ...(tags?.length                         ? { tags                                          } : {}),
            ...(taxonomyTagIds?.length                ? { taxonomyTagIds                                } : {}),
            nodeType: el.getAttribute('data-ctx-type') ?? 'text',
          },
        });
        return;
      }

      // 2. Image
      const img = target.closest('img') as HTMLImageElement | null;
      if (img) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY,
          item: { title: img.alt || 'Image', imageUrl: img.src, url: img.src, nodeType: 'note' } });
        return;
      }

      // 3. Text selection (no ctx element found)
      if (sel.length > 2) {
        e.preventDefault();
        const inChat = target.closest('.ai-messages') !== null;
        setMenu({ x: e.clientX, y: e.clientY,
          item: {
            title: inChat ? 'Athena chat' : sel.length > 80 ? sel.slice(0, 80) + '…' : sel,
            body: sel,
            fromSelection: true,
            ...(inChat ? { fromChat: true, source: 'Athena chat' } : {}),
            nodeType: 'note',
          } });
        return;
      }

      // 4. Anchor link
      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (anchor?.href) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY,
          item: { title: anchor.textContent?.trim() || anchor.href, url: anchor.href, nodeType: 'text' } });
        return;
      }
      // 5. Right-click on an Athena reply with nothing selected: act on the whole reply
      const reply = target.closest('.ai-bubble-text, .ai-bubble-text--md') as HTMLElement | null;
      if (reply) {
        const text = reply.innerText.trim();
        if (text.length > 2 && reply.closest('.ai-bubble--user') === null) {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY,
            item: { title: 'Athena chat', body: text, fromSelection: true, fromChat: true, source: 'Athena chat', nodeType: 'note' } });
          return;
        }
      }
      // 6. passthrough
    }

    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  return (
    <Ctx.Provider value={{ openMenu }}>
      {children}
      {menu && createPortal(
        <GlobalCtxMenu x={menu.x} y={menu.y} item={menu.item} onClose={() => setMenu(null)} />,
        document.body,
      )}
    </Ctx.Provider>
  );
}

type PanelState = 'menu' | 'picker';

function GlobalCtxMenu({ x, y, item, onClose }: { x: number; y: number; item: CtxItemData; onClose: () => void }) {
  const [panel, setPanel]   = useState<PanelState>('menu');
  const [selectedId, setId] = useState<string | null>(null);
  const [sent, setSent]     = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const qc  = useQueryClient();
  const navigate = useNavigate();
  const { openAthena } = useAthenaContext();
  const [results, setResults] = useState<{ action: NoteExtractionAction; label: string; to?: string }[]>([]);

  const noteId = item.fromSelection === true && item.refType === 'note' ? item.refId : undefined;
  const quote = (item.body ?? '').trim();
  const sourceNote = item.refType === 'note' ? item.title : null;

  // Records what was done with the selection so the note can mark it.
  const record = (action: NoteExtractionAction, label: string, to?: string, target?: { type: string; id: string }) => {
    setResults((r) => [...r, { action, label, ...(to ? { to } : {}) }]);
    if (!noteId || quote === '') return;
    void api.addNoteExtraction(noteId, {
      quote: quote.slice(0, 4000), action, targetLabel: label,
      ...(target ? { targetType: target.type, targetId: target.id } : {}),
    }).then(() => qc.invalidateQueries({ queryKey: ['note-extractions', noteId] }))
      .catch((err: unknown) => { console.warn('[GlobalContextMenu] could not record extraction marker:', err); });
  };

  const { mutate: extractNote, isPending: extractingNote } = useMutation({
    mutationFn: async () => {
      setActionError(null);
      const { markdownToNoteBlocks } = await import('../notes/markdownToBlocks');
      const title = quote.split('\n')[0]!.slice(0, 60).trim() || 'Extracted note';
      const doc = await createNote({ title, contentType: 'note', contentJson: JSON.stringify(markdownToNoteBlocks(quote)) });
      if (!doc) throw new Error('Could not create note.');
      return { id: doc.id, title };
    },
    onSuccess: ({ id, title }) => {
      void qc.invalidateQueries({ queryKey: ['notes'] });
      record('note', title, `/think?noteId=${id}`, { type: 'note', id });
    },
    onError: (err) => { setActionError(err instanceof Error ? err.message : 'Could not create note.'); },
  });

  const discuss = () => {
    openAthena(`Let's discuss this passage:\n\n"${quote.slice(0, 1500)}"\n\nWhat are the key points, and what should I do with it?`,
      { type: 'note', title: item.title, ...(item.refId ? { id: item.refId } : {}) });
    record('athena', 'Discussed with Athena');
    onClose();
  };

  // Reposition if near screen edge — runs after every render so dimensions are known
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right  > window.innerWidth)  el.style.left = `${x - r.width}px`;
    if (r.bottom > window.innerHeight) el.style.top  = `${y - r.height}px`;
  });

  useEffect(() => {
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown',   onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  const { data, isLoading, isError: canvasError, refetch: retryCanvases } = useQuery({
    queryKey: ['canvases-list'],
    queryFn: async () => {
      const result = await api.listCanvases();
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    staleTime: 30_000,
    enabled: panel === 'picker',
  });
  const canvases: CanvasSummaryApi[] = data?.filter((c) => c.canvasType !== 'diagram') ?? [];

  const { mutate: createSpark, isPending: creatingSpark, data: savedSpark } = useMutation({
    mutationFn: async () => {
      setActionError(null);
      const result = await api.createSpark({
        body: (item.body ?? item.title).trim(),
        tags: (item.tags ?? []).map((tag) => tag.split('|')[0] ?? tag),
        source_id: item.refId && item.refType ? item.refId : null,
        source_type: item.refId && item.refType ? item.refType : null,
      });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (spark) => {
      clearActiveBlockNoteSelectionSnapshot();
      record('spark', 'Spark', '/think?view=sparks', { type: 'spark', id: spark.id });
      void qc.invalidateQueries({ queryKey: ['sparks'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => { setActionError(error instanceof Error ? error.message : 'Could not save Spark. Please retry.'); },
  });
  const canvasItem: CtxItemData = savedSpark ? {
    title: savedSpark.body.length > 80 ? savedSpark.body.slice(0, 80) + '…' : savedSpark.body,
    body: savedSpark.body, refId: savedSpark.id, refType: 'spark', source: 'Spark',
  } : item;

  const { mutate: addNode, isPending } = useMutation({
    mutationFn: async (canvasId: string) => {
      setActionError(null);
      const result = await api.addToCanvas(canvasId, {
        label: canvasItem.title,
        ...(canvasItem.body    ? { body:    canvasItem.body    } : {}),
        ...(canvasItem.url     ? { url:     canvasItem.url     } : {}),
        ...(canvasItem.refId   ? { refId:   canvasItem.refId   } : {}),
        ...(canvasItem.refType ? { refType: canvasItem.refType } : {}),
      });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (_res, canvasId) => {
      setSent(true);
      const name = canvases.find((c) => c.id === canvasId)?.title ?? 'Canvas';
      record('canvas', name, `/think?mapId=${canvasId}`, { type: 'canvas', id: canvasId });
      void qc.invalidateQueries({ queryKey: ['canvases-list'] });
      void qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
      setPanel('menu');
    },
    onError: (err) => {
      console.error('[GlobalContextMenu] add to map failed:', err);
      setActionError(err instanceof Error ? err.message : 'Could not add to Canvas. Please retry.');
    },
  });

  const copyUrl  = async () => { if (item.url) await navigator.clipboard.writeText(item.url); onClose(); };
  const copyText = async () => { await navigator.clipboard.writeText(item.body ?? item.title); onClose(); };

  const { mutate: createTasks, isPending: creatingTasks, data: createdTaskIds } = useMutation({
    mutationFn: async () => {
      const sourceText = item.body ?? item.title;
      const tags = (item.tags ?? []).map((t) => t.split('|')[0] ?? t);
      const taxonomyTagIds = item.taxonomyTagIds ?? [];
      const parsed = await extractTasksWithAI(sourceText);
      const dueDate = toISODateString(addWorkingDays(new Date(), 2));
      const sourceNoteId = item.refType === 'note' ? item.refId : undefined;
      const created = await Promise.all(parsed.map(async (draft) => {
        const res = await api.createTask({
          title: draft.title,
          body: draft.body,
          status: 'backlog',
          dueDate,
          ...(tags.length > 0 ? { tags } : {}),
          ...(taxonomyTagIds.length > 0 ? { taxonomyTagIds } : {}),
        });
        const id = res.success ? res.data.id : undefined;
        // Link back to the note so the task card can open where it came from.
        if (id && sourceNoteId) {
          await api.addTaskLink(id, {
            targetType: 'note', targetId: sourceNoteId, targetTitle: item.title,
            targetUrl: `/think?noteId=${encodeURIComponent(sourceNoteId)}`,
          }).catch((err: unknown) => { console.warn('[GlobalContextMenu] could not link task to note:', err); });
        }
        return id;
      }));
      return created.filter((id): id is string => typeof id === 'string');
    },
    onSuccess: (ids) => {
      clearActiveBlockNoteSelectionSnapshot();
      const first = ids[0];
      record('task', ids.length > 1 ? `${ids.length} tasks` : 'Task',
        ids.length === 1 && first ? `/plan?taskId=${first}` : '/plan',
        first ? { type: 'task', id: first } : undefined);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => {
      console.error('[GlobalContextMenu] createTask failed:', err);
    },
  });
  const taskCount = createdTaskIds?.length;

  const posStyle: React.CSSProperties = { left: x, top: y };

  const hasQuote = quote !== '';
  const showSource = (sourceNote !== null && sourceNote !== quote) || item.fromChat === true;
  if (panel === 'menu') return (
    <div ref={ref} className="gctx" style={posStyle}>
      <div className="gctx__preview">
        {hasQuote && item.fromSelection === true
          ? <blockquote className="gctx__quote">{quote}</blockquote>
          : <span className="gctx__title">{item.title}</span>}
        {showSource && item.fromSelection === true
          ? <span className="gctx__source">{item.fromChat === true ? 'From Athena chat' : `From note: ${sourceNote}`}</span>
          : item.source && item.fromSelection !== true && <span className="gctx__source">{item.source}</span>}
      </div>
      <div className="gctx__divider" />
      <button className="gctx__item" onClick={() => setPanel('picker')}>
        <Diagram size={15} /> {savedSpark ? 'Send Spark to Canvas…' : 'Add to linked canvas…'}
      </button>
      {item.refType !== 'spark' && (
        <button className="gctx__item" disabled={creatingSpark || savedSpark !== undefined} onClick={() => { createSpark(); }}>
          {savedSpark ? <><Checkmark size={15} /> Spark saved</>
            : <><Idea size={15} /> {creatingSpark ? 'Saving Spark…' : 'Create Spark'}</>}
        </button>
      )}
      <button
        className="gctx__item"
        onClick={() => { createTasks(); }}
        disabled={creatingTasks || taskCount !== undefined}
      >
        {taskCount !== undefined
          ? <><Checkmark size={15} /> {taskCount > 1 ? `${taskCount} tasks created` : 'Task created'}</>
          : <><TaskAdd size={15} /> {creatingTasks ? 'Thinking…' : 'Create Task'}</>}
      </button>
      {item.fromSelection === true && (
        <>
          <button className="gctx__item" disabled={extractingNote} onClick={() => { extractNote(); }}>
            <DocumentAdd size={15} /> {extractingNote ? 'Creating note…' : 'Extract to new note'}
          </button>
          {item.fromChat !== true && (
            <button className="gctx__item" onClick={discuss}>
              <ChatBot size={15} /> Discuss with Athena
            </button>
          )}
        </>
      )}
      {(item.url || hasQuote) && <div className="gctx__divider" />}
      {item.url && (
        <button className="gctx__item" onClick={() => { void copyUrl(); }}>
          <Link size={15} /> Copy URL
        </button>
      )}
      <button className="gctx__item" onClick={() => { void copyText(); }}>
        <Copy size={15} /> Copy text
      </button>
      {results.length > 0 && (
        <div className="gctx__results">
          {results.map((r, i) => (
            <div key={i} className="gctx__result">
              <Checkmark size={14} />
              <span>{r.label}</span>
              {r.to && <button type="button" onClick={() => { navigate(r.to!); onClose(); }}>Open <ArrowRight size={12} /></button>}
            </div>
          ))}
        </div>
      )}
      {actionError && <p className="gctx__error" role="alert">{actionError}</p>}
    </div>
  );

  return (
    <div ref={ref} className="gctx gctx--picker" style={posStyle}>
      <div className="gctx__picker-header">
        <button className="gctx__picker-back" onClick={() => setPanel('menu')}>←</button>
        <span>Add to linked canvas</span>
      </div>
      <div className="gctx__picker-preview">
        {canvasItem.source && <div className="gctx__picker-source">{canvasItem.source}</div>}
        <div className="gctx__picker-ptitle">{canvasItem.title}</div>
        {canvasItem.body && <div className="gctx__picker-pbody">{canvasItem.body.length > 140 ? canvasItem.body.slice(0, 140) + '…' : canvasItem.body}</div>}
        {canvasItem.imageUrl && <img src={canvasItem.imageUrl} alt="" className="gctx__picker-img" />}
      </div>
      <div className="gctx__picker-list">
        {isLoading && <div className="gctx__picker-empty">Loading…</div>}
        {canvasError && <div className="gctx__error" role="alert">Could not load canvases. <button className="gctx__picker-back" type="button" onClick={() => { void retryCanvases(); }}>Retry</button></div>}
        {!isLoading && !canvasError && canvases.length === 0 && <div className="gctx__picker-empty">No brainstorm canvases yet. Create one from Think → Canvas.</div>}
        {canvases.map((c) => (
          <button
            key={c.id}
            className={`gctx__picker-canvas${selectedId === c.id ? ' gctx__picker-canvas--active' : ''}`}
            onClick={() => setId(c.id)}
          >
            <Diagram size={14} /><span>{c.title}</span>{selectedId === c.id && <Checkmark size={13} />}
          </button>
        ))}
      </div>
      <button
        className="gctx__picker-send"
        disabled={!selectedId || isPending || sent}
        onClick={() => { if (selectedId) addNode(selectedId); }}
      >
        {sent ? <><Checkmark size={14} /> Added!</> : isPending ? 'Adding…' : 'Add to Canvas'}
      </button>
      {actionError && <p className="gctx__error" role="alert">{actionError}</p>}
    </div>
  );
}
