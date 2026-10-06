import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Checkmark } from '@carbon/icons-react';
import type { NavigationDestination, NavigationGroup } from '../navigation/destinations';

interface Props {
  id: string;
  label: string;
  groups: NavigationGroup[];
  selectedId?: string | undefined;
  attentionIds?: string[] | undefined;
  onAction: (item: NavigationDestination) => void;
  onClose: (restoreFocus: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
  initialFocus: 'first' | 'last';
}

export function NavigationMenu({ id, label, groups, selectedId, attentionIds = [], onAction, onClose, triggerRef, initialFocus }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    (initialFocus === 'last' ? items?.[items.length - 1] : items?.[0])?.focus();
    const outside = (event: PointerEvent | FocusEvent): void => {
      if (event.target instanceof Node && !ref.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [initialFocus, onClose, triggerRef]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === ' ' && event.target instanceof HTMLAnchorElement) {
      event.preventDefault();
      event.target.click();
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.findIndex((item) => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return <div id={id} ref={ref} className="kh-nav-menu" role="menu" aria-label={label}
    onKeyDown={onKeyDown} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== triggerRef.current) onClose(false);
    }}>
    {groups.map((group, index) => <div key={group.label} role="group" aria-labelledby={`${id}-group-${index}`} className="kh-nav-menu__group">
      <p id={`${id}-group-${index}`} className="kh-nav-menu__heading">{group.label}</p>
      {group.items.map((item) => {
        const Icon = item.icon;
        const selected = item.id === selectedId;
        const content = <><Icon size={20} /><span className="kh-nav-menu__text"><span>{item.label}</span>
          {item.description && <small>{item.description}</small>}</span>
          {selected && <Checkmark size={16} aria-hidden="true" />}
          {attentionIds.includes(item.id) && <span className="kh-nav-menu__attention" aria-label="Suggestions need review" />}</>;
        const common = {
          role: 'menuitem', tabIndex: -1,
          className: `kh-nav-menu__item${selected ? ' kh-nav-menu__item--selected' : ''}`,
          'aria-current': selected ? 'page' as const : undefined,
          onClick: () => { onAction(item); },
        };
        return item.path ? <Link key={item.id} to={item.path} {...common}>{content}</Link>
          : <button key={item.id} type="button" {...common}>{content}</button>;
      })}
    </div>)}
  </div>;
}
