export type RuntimePhase = 'starting' | 'ready' | 'failed' | 'stopping';

export interface RuntimeDependencies {
  initialize: () => Promise<void>;
  startJobs: () => void;
  stopJobs: () => void;
  closeServer: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  exit: (code: number) => void;
  logError: (message: string, error: unknown) => void;
}

interface Runtime {
  readonly phase: RuntimePhase;
  start: () => Promise<void>;
  stop: (code?: number) => Promise<void>;
}
const SHUTDOWN_TIMEOUT_MS = 15_000;
export function createRuntime(deps: RuntimeDependencies, shutdownMs = SHUTDOWN_TIMEOUT_MS): Runtime {
  let phase: RuntimePhase = 'starting';
  let shutdown: Promise<void> | undefined;
  let exitCode = 0;
  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };
  return {
    get phase(): RuntimePhase { return phase; },
    async start(): Promise<void> {
      try {
        await deps.initialize();
        if (phase !== 'starting') return;
        deps.startJobs();
        phase = 'ready';
      } catch (error) {
        if (phase === 'starting') phase = 'failed';
        deps.logError('[Server] Initialization failed; readiness remains false and jobs are disabled.', error);
        throw error;
      }
    },
    stop(code = 0): Promise<void> {
      exitCode = Math.max(exitCode, code);
      if (shutdown !== undefined) return shutdown;
      phase = 'stopping';
      shutdown = (async (): Promise<void> => {
        const deadline = setTimeout(() => { finish(1); }, shutdownMs);
        deadline.unref();
        try {
          try { deps.stopJobs(); } catch (error) {
            exitCode = 1;
            deps.logError('[Server] Job shutdown failed.', error);
          }
          for (const [name, close] of [['HTTP server', deps.closeServer], ['database', deps.closeDatabase]] as const) {
            try { await close(); } catch (error) {
              exitCode = 1;
              deps.logError(`[Server] ${name} shutdown failed.`, error);
            }
          }
        } finally {
          clearTimeout(deadline);
          finish(exitCode);
        }
      })();
      return shutdown;
    },
  };
}

export function assertSafeDatabase(mode: string, databaseUrl: string, nodeEnv: string): void {
  if (nodeEnv === 'production') return;
  if (mode === 'disposable') return;
  if (mode === 'local') {
    const hostname = new URL(databaseUrl).hostname;
    if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return;
  }
  throw new Error('Non-production startup requires DATABASE_MODE=local with a loopback database, or DATABASE_MODE=disposable for an explicitly selected disposable database.');
}
