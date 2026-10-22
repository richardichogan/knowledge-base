import { useLayoutEffect, type RefObject } from 'react';

/** Keep anchored menus above clipped panels and native modal drill-downs. */
export function useAnchoredPopovers(root: RefObject<HTMLElement>, selector: string | null, above = false): void {
  useLayoutEffect(() => {
    if (!selector) return;
    const elements = [...(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
      .filter(element => typeof element.showPopover === 'function');
    const position = (): void => {
      for (const element of elements) {
        const anchor = element.parentElement?.getBoundingClientRect();
        if (!anchor) continue;
        const margin = 8;
        const width = Math.min(element.offsetWidth, window.innerWidth - margin * 2);
        element.style.maxWidth = `${window.innerWidth - margin * 2}px`;
        element.style.maxHeight = `${window.innerHeight - margin * 2}px`;
        element.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
        const preferredTop = above ? anchor.top - element.offsetHeight - margin : anchor.bottom + margin;
        element.style.top = `${Math.max(margin, Math.min(preferredTop, window.innerHeight - element.offsetHeight - margin))}px`;
      }
    };
    for (const element of elements) {
      element.setAttribute('popover', 'manual');
      element.showPopover();
    }
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    const observer = new ResizeObserver(position);
    elements.forEach(element => { observer.observe(element); });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      for (const element of elements) {
        if (element.matches(':popover-open')) element.hidePopover();
      }
    };
  }, [root, selector, above]);
}
