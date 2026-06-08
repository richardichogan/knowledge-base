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
import { Checkmark, Diagram, Link, Copy } from '@carbon/icons-react';
import { api } from '../services/api';
import type { CanvasSummaryApi } from '../services/api';

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
}

interface MenuState { x: number; y: number; item: CtxItemData; }
interface GlobalCtxMenuCtx { openMenu: (e: MouseEvent | React.MouseEvent, item: CtxItemData) => void; }

const Ctx = createContext<GlobalCtxMenuCtx>({ openMenu: () => {} });
export function useGlobalContextMenu() { return useContext(Ctx); }

export function GlobalContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = useCallback((e: MouseEvent | React.MouseEvent, item: CtxItemData) => {
    e.preventDefault();
    setMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY, item });
  }, []);

  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const sel = window.getSelection()?.toString().trim() ?? '';

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
        setMenu({
          x: e.clientX, y: e.clientY,
          item: {
            title:   ctxTitle,
            ...(body                                  ? { body                                         } : {}),
            ...(el.getAttribute('data-ctx-source')   ? { source:  el.getAttribute('data-ctx-source')! } : {}),
            ...(el.getAttribute('data-ctx-url')      ? { url:     el.getAttribute('data-ctx-url')!    } : {}),
            ...(el.getAttribute('data-ctx-ref-id')   ? { refId:   el.getAttribute('data-ctx-ref-id')! } : {}),
            ...(el.getAttribute('data-ctx-ref-type') ? { refType: el.getAttribute('data-ctx-ref-type')!} : {}),
            ...(tags?.length                         ? { tags                                          } : {}),
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
        setMenu({ x: e.clientX, y: e.clientY,
          item: {
            title: sel.length > 80 ? sel.slice(0, 80) + '…' : sel,
            ...(sel.length > 80 ? { body: sel } : {}),
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
      // 5. passthrough
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
  const ref = useRef<HTMLDivElement>(null);
  const qc  = useQueryClient();

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

  const { data, isLoading } = useQuery({
    queryKey: ['canvases-list'],
    queryFn: () => api.listCanvases(),
    staleTime: 30_000,
    enabled: panel === 'picker',
  });
  const canvases: CanvasSummaryApi[] = data?.success ? data.data : [];

  const { mutate: addNode, isPending } = useMutation({
    mutationFn: (canvasId: string) => {
      // Backend NodeType only accepts 'hub_ref' | 'text' | 'ai_output'
      // Any item with a refId is a reference — use hub_ref.
      // Fall back to 'text' for plain freeform items.
      const rawType = item.nodeType;
      const nodeType: 'hub_ref' | 'text' | 'ai_output' =
        rawType === 'ai_output' ? 'ai_output'
        : (item.refId || rawType === 'hub_ref') ? 'hub_ref'
        : 'text';
      return api.createCanvasNode(canvasId, {
        nodeType,
        label: item.title,
        ...(item.body    ? { body:    item.body    } : {}),
        ...(item.url     ? { url:     item.url     } : {}),
        ...(item.refId   ? { refId:   item.refId   } : {}),
        ...(item.refType ? { refType: item.refType } : {}),
        ...(item.tags?.length ? { tags: item.tags } : {}),
        x: 100 + Math.random() * 180,
        y: 100 + Math.random() * 180,
        width: 300,
      });
    },
    onSuccess: (_res, canvasId) => {
      setSent(true);
      void qc.invalidateQueries({ queryKey: ['canvases-list'] });
      void qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
      setTimeout(onClose, 1400);
    },
    onError: (err) => {
      console.error('[GlobalContextMenu] createCanvasNode failed:', err);
    },
  });

  const copyUrl  = async () => { if (item.url) await navigator.clipboard.writeText(item.url); onClose(); };
  const copyText = async () => { await navigator.clipboard.writeText(item.body ?? item.title); onClose(); };

  const posStyle: React.CSSProperties = { left: x, top: y };

  if (panel === 'menu') return (
    <div ref={ref} className="gctx" style={posStyle}>
      <div className="gctx__preview">
        {item.source && <span className="gctx__source">{item.source}</span>}
        <span className="gctx__title">{item.title}</span>
      </div>
      <div className="gctx__divider" />
      <button className="gctx__item" onClick={() => setPanel('picker')}>
        <Diagram size={15} /> Send to Canvas…
      </button>
      {item.url && (
        <button className="gctx__item" onClick={() => { void copyUrl(); }}>
          <Link size={15} /> Copy URL
        </button>
      )}
      <button className="gctx__item" onClick={() => { void copyText(); }}>
        <Copy size={15} /> Copy text
      </button>
    </div>
  );

  return (
    <div ref={ref} className="gctx gctx--picker" style={posStyle}>
      <div className="gctx__picker-header">
        <button className="gctx__picker-back" onClick={() => setPanel('menu')}>←</button>
        <span>Send to Canvas</span>
      </div>
      <div className="gctx__picker-preview">
        {item.source && <div className="gctx__picker-source">{item.source}</div>}
        <div className="gctx__picker-ptitle">{item.title}</div>
        {item.body && <div className="gctx__picker-pbody">{item.body.length > 140 ? item.body.slice(0, 140) + '…' : item.body}</div>}
        {item.imageUrl && <img src={item.imageUrl} alt="" className="gctx__picker-img" />}
      </div>
      <div className="gctx__picker-list">
        {isLoading && <div className="gctx__picker-empty">Loading…</div>}
        {!isLoading && canvases.length === 0 && <div className="gctx__picker-empty">No canvases yet</div>}
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
    </div>
  );
}
