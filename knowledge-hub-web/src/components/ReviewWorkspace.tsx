import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { SidePanelClose, SidePanelOpen } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { PaneResizer } from './PaneResizer';
import { ThinkAthenaPanel } from '../notes/ThinkAthenaPanel';
import { useAthenaContext, type AthenaPageContext } from '../context/AthenaContext';
import { usePersistedBoolean, usePersistedPaneWidth } from '../hooks/usePersistedState';

interface Props {
  storageKey: string;
  label: string;
  list: React.ReactNode;
  detail: React.ReactNode;
  context: AthenaPageContext;
  athenaEnabled?: boolean;
}

export function ReviewWorkspace({ storageKey, label, list, detail, context, athenaEnabled = true }: Props): React.ReactElement {
  const id = useId();
  const host = useRef<HTMLDivElement>(null);
  const chat = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(1200);
  const [listWidth, setListWidth] = usePersistedPaneWidth(`${storageKey}-list`, { compact: 390, wide: 560, min: 240, max: 760 });
  const [chatWidth, setChatWidth] = usePersistedPaneWidth(`${storageKey}-athena`, { compact: 360, wide: 420, min: 300, max: 560 });
  const [collapsed, setCollapsed] = usePersistedBoolean(`kh_${storageKey}_athena_collapsed`, true);
  const [busy, setBusy] = useState(false);
  const wasBusy = useRef(false);
  const queryClient = useQueryClient();
  const [promptRequest, setPromptRequest] = useState<{ prompt: string; sequence: number }>();
  const { pageContext, setAthenaContext, registerAthenaLauncher, request, clearAthenaRequest } = useAthenaContext();
  const latestContext = useRef(context);
  latestContext.current = context;
  const contextKey = JSON.stringify(context);
  const selectionKey = `${context.type}:${context.id ?? context.title}`;
  useLayoutEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [selectionKey]);
  const handleBusyChange = useCallback((next: boolean): void => {
    setBusy(next);
    if (wasBusy.current && !next) {
      const keys = storageKey === 'today' || storageKey === 'plan-task' ? ['today', 'tasks', 'task-assistance', 'notes-list', 'podcast-prep', 'upcoming-meetings']
        : storageKey === 'discover-publishing' ? ['publishing']
          : ['discover', 'cfps', 'watchlists', 'watchlist-runs', 'watchlist-companies'];
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    wasBusy.current = next;
  }, [queryClient, storageKey]);

  useLayoutEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const measure = (): void => { setAvailable(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);

  useLayoutEffect(() => {
    if (!athenaEnabled) return;
    setAthenaContext(latestContext.current);
    return () => { setAthenaContext(null); };
  }, [contextKey, athenaEnabled, setAthenaContext]);

  const launch = useCallback(() => {
    setCollapsed(false);
    window.requestAnimationFrame(() => { chat.current?.querySelector('textarea')?.focus(); });
  }, [setCollapsed]);

  useEffect(() => {
    if (!athenaEnabled) return;
    return registerAthenaLauncher(launch);
  }, [athenaEnabled, launch, registerAthenaLauncher]);

  useEffect(() => {
    if (!athenaEnabled || !request) return;
    setPromptRequest(request);
    launch();
    clearAthenaRequest();
  }, [athenaEnabled, request, clearAthenaRequest, launch]);

  useEffect(() => {
    if (!athenaEnabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setCollapsed(previous => !previous);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [athenaEnabled, setCollapsed]);

  const shownChatWidth = Math.min(chatWidth, Math.max(300, available - 240 - 320 - 14));
  const shownListWidth = Math.min(listWidth, Math.max(240, available - 320 - (collapsed || !athenaEnabled ? 42 : shownChatWidth + 14)));
  return (
    <div ref={host} className="kh-review-workspace" aria-label={label}>
      <section className="kh-review-workspace__list" aria-label={`${label} items`} style={{ width: shownListWidth }}>
        {list}
      </section>
      <PaneResizer width={shownListWidth} onResize={setListWidth} side="left" label={`Resize ${label.toLowerCase()} list`} />
      <section ref={detailRef} className="kh-review-workspace__detail" aria-label="Selected item details">{detail}</section>
      {athenaEnabled && <>
        {collapsed ? <div className="kh-review-workspace__rail">
          <button type="button" className="kh-review-workspace__toggle" aria-label="Open Athena" title="Open Athena (⌘J / Ctrl+J)"
            aria-expanded={false} aria-controls={id} onClick={launch}><SidePanelOpen size={18} /></button>
          <span className="kh-review-workspace__rail-label">Athena</span>
          <span className={`think-athena-status__dot${busy ? ' think-athena-status__dot--busy' : ''}`}
            role="img" aria-label={busy ? 'Athena is generating a reply' : 'Athena is idle'} />
        </div> : <PaneResizer width={shownChatWidth} onResize={setChatWidth} side="right" label="Resize Athena" />}
        <aside ref={chat} id={id} className="kh-review-workspace__athena" aria-label="Athena" hidden={collapsed} style={{ width: shownChatWidth }}>
          <header className="kh-review-workspace__athena-header">
            <h2>Athena</h2>
            <button type="button" className="kh-review-workspace__toggle" aria-label="Collapse Athena" aria-expanded={true}
              aria-controls={id} onClick={() => { setCollapsed(true); }}><SidePanelClose size={18} /></button>
          </header>
          <ThinkAthenaPanel pageContext={pageContext ?? context} onBusyChange={handleBusyChange} promptRequest={promptRequest} />
        </aside>
      </>}
    </div>
  );
}

export function ReviewItem({ title, meta, description, selected, onSelect }: {
  title: string; meta?: string | undefined; description?: string | undefined; selected: boolean; onSelect: () => void;
}): React.ReactElement {
  return <button type="button" className={`kh-review-item${selected ? ' kh-review-item--selected' : ''}`}
    aria-pressed={selected} onClick={onSelect}>
    {meta && <span className="kh-review-item__meta">{meta}</span>}
    <span className="kh-review-item__title">{title}</span>
    {description && <span className="kh-review-item__description">{description}</span>}
  </button>;
}
