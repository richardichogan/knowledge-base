/**
 * features/sparks/SparkMenu.tsx
 * Small popover menu (button + list of actions) used on spark items and theme cards.
 */
import React, { useEffect, useRef, useState } from 'react';

export interface SparkMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export const SparkMenu: React.FC<{
  label: React.ReactNode;
  ariaLabel: string;
  items: SparkMenuItem[];
  buttonClassName?: string;
  align?: 'left' | 'right';
}> = ({ label, ariaLabel, items, buttonClassName = 'spark-menu__trigger', align = 'right' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div className="spark-menu" ref={ref}>
      <button type="button" className={buttonClassName} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen((v) => !v); }}>{label}</button>
      {open && (
        <div className={`spark-menu__list spark-menu__list--${align}`} role="menu">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
              className={`spark-menu__item${item.danger ? ' spark-menu__item--danger' : ''}`}
              onClick={() => { setOpen(false); item.onSelect(); }}>{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
};
