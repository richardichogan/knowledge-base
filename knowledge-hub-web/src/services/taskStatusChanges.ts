export interface TaskStatusMove {
  taskId: string;
  title: string;
  from: string;
  to: string;
}

export interface TaskStatusRequest {
  id: number;
  moves: TaskStatusMove[];
  initialNote: string;
  apply: (note: string) => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

let nextId = 0;
let queue: TaskStatusRequest[] = [];
const listeners = new Set<() => void>();
const emit = (): void => { listeners.forEach(listener => { listener(); }); };

export const currentTaskStatusRequest = (): TaskStatusRequest | null => queue[0] ?? null;
export function subscribeTaskStatusRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function requestTaskStatusChange(moves: TaskStatusMove[], apply: (note: string) => Promise<void>, initialNote = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    queue = [...queue, { id: ++nextId, moves, apply, initialNote, resolve, reject }];
    emit();
  });
}
export function finishTaskStatusRequest(id: number, cancelled = false): void {
  const request = queue[0];
  if (!request || request.id !== id) return;
  queue = queue.slice(1);
  if (cancelled) request.reject(new Error('Status-change dialog cancelled. No further changes were submitted.'));
  else request.resolve();
  emit();
}
