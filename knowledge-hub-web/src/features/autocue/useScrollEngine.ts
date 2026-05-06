/**
 * useScrollEngine.ts
 *
 * RAF-based scroll engine driven by a target speed in pixels/second.
 * Speed is smoothed with exponential decay so rate changes feel fluid.
 * Scroll position is integrated from speed on each frame — no position jumping.
 */

import { useRef, useCallback, useEffect } from 'react';

/** Smoothing factor: 0.05 = very smooth, 0.30 = snappy. ~200ms catch-up. */
const SPEED_SMOOTHING = 0.15;

export interface ScrollEngine {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Target speed in px/sec. Set to 0 to stop. */
  targetSpeedRef: React.MutableRefObject<number>;
  /** Reset scroll to 0 and clear speed. */
  reset: () => void;
  isScrolling: React.RefObject<boolean>;
}

export function useScrollEngine(): ScrollEngine {
  const containerRef   = useRef<HTMLDivElement>(null);
  const targetSpeedRef = useRef<number>(0);
  const displayedSpeed = useRef<number>(0);
  const rafId          = useRef<number | null>(null);
  const lastTs         = useRef<number | null>(null);
  const isScrolling    = useRef(false);

  const animate = useCallback((ts: number) => {
    if (lastTs.current === null) lastTs.current = ts;
    const dt = Math.min((ts - lastTs.current) / 1000, 0.1);
    lastTs.current = ts;

    displayedSpeed.current +=
      (targetSpeedRef.current - displayedSpeed.current) * SPEED_SMOOTHING;

    const el = containerRef.current;
    if (el && displayedSpeed.current > 0.5) {
      el.scrollTop += displayedSpeed.current * dt;
      isScrolling.current = true;
      if (el.scrollTop >= el.scrollHeight - el.clientHeight) {
        targetSpeedRef.current = 0;
        displayedSpeed.current = 0;
        isScrolling.current = false;
      }
    } else {
      isScrolling.current = false;
    }

    rafId.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    rafId.current = requestAnimationFrame(animate);
    return () => { if (rafId.current !== null) cancelAnimationFrame(rafId.current); };
  }, [animate]);

  const reset = useCallback(() => {
    targetSpeedRef.current = 0;
    displayedSpeed.current = 0;
    if (containerRef.current) containerRef.current.scrollTop = 0;
    isScrolling.current = false;
  }, []);

  return { containerRef, targetSpeedRef, reset, isScrolling };
}
