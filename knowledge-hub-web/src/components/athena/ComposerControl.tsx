import React, { useEffect, useId, useRef, useState } from 'react';
import { useAnchoredPopovers } from '../../hooks/useAnchoredPopovers';

export function ComposerControl({ label, icon, active = false, children }: {
  label: string; icon: React.ReactNode; active?: boolean; children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useAnchoredPopovers(root, open ? '.kh-composer-control__panel' : null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLSelectElement>('select')?.focus();
    const dismiss = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const focusOut = (event: FocusEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('focusin', focusOut);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('focusin', focusOut);
    };
  }, [open]);
  return <div ref={root} className="kh-composer-control" onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" className={`kh-composer-control__trigger${active ? ' kh-composer-control__trigger--active' : ''}`}
      aria-label={label} title={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setOpen(value => !value); }}>{icon}</button>
    {open && <div id={id} className="kh-composer-control__panel" role="group" aria-label={label}
      onChange={() => { setOpen(false); trigger.current?.focus(); }}>
      <span className="kh-composer-control__label">{label}</span>
      {children}
    </div>}
  </div>;
}
