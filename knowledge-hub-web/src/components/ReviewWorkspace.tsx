import React, { useLayoutEffect, useRef, useState } from 'react';
import { PaneResizer } from './PaneResizer';
import { useAthenaContext, type AthenaPageContext } from '../context/AthenaContext';
import { usePersistedPaneWidth } from '../hooks/usePersistedState';

interface Props {
  storageKey: string;
  label: string;
  list: React.ReactNode;
  detail: React.ReactNode;
  context: AthenaPageContext;
  athenaEnabled?: boolean;
}

/**
 * List | detail review layout. Athena reads the selected item through the page
 * context and answers in the floating chat opened from the bottom-right launcher.
 */
export function ReviewWorkspace({ storageKey, label, list, detail, context, athenaEnabled = true }: Props): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(1200);
  const [listWidth, setListWidth] = usePersistedPaneWidth(`${storageKey}-list`, { compact: 390, wide: 560, min: 240, max: 760 });
  const { setAthenaContext } = useAthenaContext();
  const latestContext = useRef(context);
  latestContext.current = context;
  const contextKey = JSON.stringify(context);
  const selectionKey = `${context.type}:${context.id ?? context.title}`;
  useLayoutEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [selectionKey]);

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

  const shownListWidth = Math.min(listWidth, Math.max(240, available - 320));
  return (
    <div ref={host} className="kh-review-workspace" aria-label={label}>
      <section className="kh-review-workspace__list" aria-label={`${label} items`} style={{ width: shownListWidth }}>
        {list}
      </section>
      <PaneResizer width={shownListWidth} onResize={setListWidth} side="left" label={`Resize ${label.toLowerCase()} list`} />
      <section ref={detailRef} className="kh-review-workspace__detail" aria-label="Selected item details">{detail}</section>
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
