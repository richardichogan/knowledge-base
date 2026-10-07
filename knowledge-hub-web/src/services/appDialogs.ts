export interface DialogOptions {
  title?: string;
  confirmLabel?: string;
  tone?: 'info' | 'success' | 'danger';
}

export interface DialogRequest extends DialogOptions {
  id: number;
  message: string;
  kind: 'alert' | 'confirm';
  resolve: (confirmed: boolean) => void;
}

let nextId = 0;
let queue: DialogRequest[] = [];
const listeners = new Set<() => void>();

function emit(): void { listeners.forEach((listener) => listener()); }

export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentDialog(): DialogRequest | null { return queue[0] ?? null; }

export function settleDialog(id: number, confirmed: boolean): void {
  const request = queue[0];
  if (!request || request.id !== id) return;
  queue = queue.slice(1);
  request.resolve(confirmed);
  emit();
}

function enqueue(kind: DialogRequest['kind'], message: string, options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, id: ++nextId, kind, message, resolve }];
    emit();
  });
}

export async function alertDialog(message: string, options: DialogOptions = {}): Promise<void> {
  await enqueue('alert', message, options);
}

export function confirmDialog(message: string, options: DialogOptions = {}): Promise<boolean> {
  return enqueue('confirm', message, options);
}
