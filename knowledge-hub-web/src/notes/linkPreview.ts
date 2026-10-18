import type { EntityLinkTarget } from './entityLinks';

const EVENT = 'kh:link-preview';

/** Returns true when a side panel handled the preview; false means the caller should navigate. */
export function openLinkPreview(target: EntityLinkTarget): boolean {
  return !window.dispatchEvent(new CustomEvent<EntityLinkTarget>(EVENT, { detail: target, cancelable: true }));
}

export function onLinkPreview(handler: (target: EntityLinkTarget) => void): () => void {
  const listener = (event: Event): void => { event.preventDefault(); handler((event as CustomEvent<EntityLinkTarget>).detail); };
  window.addEventListener(EVENT, listener);
  return () => { window.removeEventListener(EVENT, listener); };
}
