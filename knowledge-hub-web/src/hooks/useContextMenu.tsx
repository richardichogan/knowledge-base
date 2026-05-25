/**
 * hooks/useContextMenu.ts
 * Shared right-click context menu hook — renders via a React portal.
 *
 * Usage:
 *   const { menuProps, triggerProps, close } = useContextMenu(items);
 *   <div {...triggerProps}>...</div>
 *   {menuProps.isOpen && <ContextMenuPortal {...menuProps} />}
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const open = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
    function onClick() { close(); }
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [menu, close]);

  const portal = menu
    ? createPortal(
        <ContextMenuPanel x={menu.x} y={menu.y} items={menu.items} onClose={close} />,
        document.body,
      )
    : null;

  return { open, close, portal };
}

// ─── Portal component ─────────────────────────────────────────────────────────

interface PanelProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

function ContextMenuPanel({ x, y, items, onClose }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Flip position if near viewport edge
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      ref.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      ref.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  return (
    <div ref={ref} className="ctx-menu" style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) => (
        <button
          key={i}
          className={`ctx-menu__item${item.danger ? ' ctx-menu__item--danger' : ''}${item.disabled ? ' ctx-menu__item--disabled' : ''}`}
          disabled={item.disabled}
          onClick={() => { item.onClick(); onClose(); }}
        >
          {item.icon && <span className="ctx-menu__icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}
