/** Single-key list shortcuts never run in editors, controls or open overlays. */
export function listShortcut(event: { target: EventTarget | null; key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (!(event.target instanceof HTMLElement)) return null;
  if (event.target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"]')) return null;
  if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return null;
  const key = event.key.toLowerCase();
  return ['j', 'k', 's', 'a', 'o'].includes(key) ? key : null;
}

export function moveListFocus(container: HTMLElement, selector: string, backwards: boolean): void {
  const items = [...container.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length > 0);
  const index = items.findIndex(item => item === document.activeElement);
  const next = index < 0 ? backwards ? items.length - 1 : 0 : Math.max(0, Math.min(items.length - 1, index + (backwards ? -1 : 1)));
  items[next]?.focus({ preventScroll: true });
  items[next]?.scrollIntoView({ block: 'nearest' });
}
