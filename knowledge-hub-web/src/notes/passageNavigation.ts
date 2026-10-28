type Request = { noteId: string; passageId: string; sequence: number };
let current: Request | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

export function requestPassageNavigation(noteId: string, passageId: string): void {
  current = { noteId, passageId, sequence: ++sequence };
  listeners.forEach(listener => { listener(); });
}

export function consumePassageNavigation(requestSequence: number): void {
  if (current?.sequence !== requestSequence) return;
  current = null;
  listeners.forEach(listener => { listener(); });
}

export function subscribePassageNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function passageNavigationSnapshot(): Request | null {
  return current;
}
