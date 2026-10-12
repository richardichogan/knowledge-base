import type { SyncRun } from './api';

export async function pollSyncRun(
  read: (signal: AbortSignal) => Promise<SyncRun>,
  signal: AbortSignal,
  intervalMs = 5_000,
  timeoutMs = 30 * 60_000,
): Promise<SyncRun> {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let lastFailure = '';
  const deadline = setTimeout(() => {
    controller.abort(new Error(`Sync monitoring timed out${lastFailure ? ` (${lastFailure})` : ''}. The server job may still be running; completion has not been confirmed.`));
  }, timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else controller.signal.addEventListener('abort', () => { reject(controller.signal.reason); }, { once: true });
  });
  try {
    while (!controller.signal.aborted) {
      try {
        const run = await Promise.race([read(controller.signal), aborted]);
        lastFailure = '';
        if (run.status !== 'running') return run;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      await new Promise<void>((resolve, reject) => {
        const interrupted = (): void => { clearTimeout(timer); reject(controller.signal.reason); };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', interrupted);
          resolve();
        }, intervalMs);
        controller.signal.addEventListener('abort', interrupted, { once: true });
        if (controller.signal.aborted) interrupted();
      });
    }
    throw controller.signal.reason;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  }
}
