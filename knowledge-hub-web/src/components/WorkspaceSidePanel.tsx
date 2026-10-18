import React, { useCallback, useEffect, useId, useLayoutEffect, useState } from 'react';
import { SidePanelOpen } from '@carbon/icons-react';
import { PaneResizer } from './PaneResizer';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { usePersistedBoolean } from '../hooks/usePersistedState';

export function useResponsivePanelState(
  storageKey: string,
  panelRef: React.RefObject<HTMLDialogElement>,
  panelWidth: number,
  defaultCollapsed = false,
): {
  collapsed: boolean;
  setCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  overlay: boolean;
} {
  const narrow = useMediaQuery('(max-width: 1199px)');
  const [constrained, setConstrained] = useState(false);
  const overlay = narrow || constrained;
  const [storedCollapsed, setStoredCollapsed] = usePersistedBoolean(storageKey, defaultCollapsed);
  const [compactOpen, setCompactOpen] = useState(false);

  useLayoutEffect(() => {
    let host = panelRef.current?.parentElement;
    while (host && getComputedStyle(host).display === 'contents') host = host.parentElement;
    if (!host) return;
    const container = host;
    const measure = (): void => { setConstrained(container.clientWidth < panelWidth + 360); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => { observer.disconnect(); };
  }, [panelRef, panelWidth]);

  useEffect(() => {
    if (!overlay) setCompactOpen(false);
  }, [overlay]);

  const setCollapsed = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((next) => {
    if (overlay) {
      setCompactOpen(previous => !(typeof next === 'function' ? next(!previous) : next));
    } else {
      setStoredCollapsed(next);
    }
  }, [overlay, setStoredCollapsed]);

  return { collapsed: overlay ? !compactOpen : storedCollapsed, setCollapsed, overlay };
}

interface WorkspaceSidePanelProps {
  panelRef: React.RefObject<HTMLDialogElement>;
  label: string;
  width: number;
  onResize: (width: number) => void;
  collapsed: boolean;
  setCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  overlay: boolean;
  status?: 'busy' | 'idle' | undefined;
  className?: string;
  children: React.ReactNode;
}

export function WorkspaceSidePanel({
  panelRef, label, width, onResize, collapsed, setCollapsed, overlay, status, className, children,
}: WorkspaceSidePanelProps): React.ReactElement {
  const id = useId();

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    if (panel.open) panel.close();
    if (!collapsed) {
      if (overlay) panel.showModal();
      else panel.setAttribute('open', '');
    }
  }, [collapsed, overlay, panelRef]);

  return (
    <>
      {collapsed || overlay ? (
        <div className="think-side-strip">
          <button type="button" className="think-side-strip__btn"
            title="Open side panel (⌘J)" aria-label={`Open ${label.toLowerCase()}`}
            aria-expanded={!collapsed} aria-controls={id} aria-haspopup={overlay ? 'dialog' : undefined}
            onClick={() => { setCollapsed(false); }}>
            <SidePanelOpen size={16} className="think-side-strip__icon" />
          </button>
          {status !== undefined && <span className={`think-athena-status__dot${status === 'busy' ? ' think-athena-status__dot--busy' : ''}`}
            title={status === 'busy' ? 'Athena is thinking…' : 'Athena ready'} />}
        </div>
      ) : (
        <PaneResizer width={width} onResize={onResize} side="right" label={`Resize ${label.toLowerCase()}`} />
      )}
      <dialog ref={panelRef} id={id} aria-label={label} role={overlay ? 'dialog' : 'complementary'}
        className={`notes-meta-panel kh-workspace-panel${overlay ? ' kh-workspace-panel--overlay' : ''}${className ? ` ${className}` : ''}`}
        style={{ width: `${width}px`, minWidth: overlay ? 0 : `${width}px` }}
        onCancel={event => { event.preventDefault(); setCollapsed(true); }}
        onClose={() => { if (!panelRef.current?.open && !collapsed) setCollapsed(true); }}
        onClick={event => {
          if (!overlay || event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
            setCollapsed(true);
          }
        }}>
        {children}
      </dialog>
    </>
  );
}
