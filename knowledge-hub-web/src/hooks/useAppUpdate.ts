import { useCallback, useEffect, useState } from 'react';

const CHECK_INTERVAL_MS = 10 * 60_000;

/** Reports when a newer build of Athena has been deployed than the one running. */
export function useAppUpdate(): { available: boolean; dismiss: () => void } {
  const [available, setAvailable] = useState(false);
  const [dismissedBuild, setDismissedBuild] = useState<string | null>(null);
  const [latestBuild, setLatestBuild] = useState<string | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) return undefined;
    let cancelled = false;
    const check = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as { build?: unknown };
        if (cancelled || typeof body.build !== 'string') return;
        setLatestBuild(body.build);
        setAvailable(body.build !== __APP_BUILD_ID__);
      } catch {
        // Offline or mid-deploy: try again at the next check.
      }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
    const onVisible = (): void => { void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const dismiss = useCallback(() => { setDismissedBuild(latestBuild); }, [latestBuild]);
  return { available: available && dismissedBuild !== latestBuild, dismiss };
}
