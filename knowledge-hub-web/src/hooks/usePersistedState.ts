/**
 * hooks/usePersistedState.ts — small localStorage-backed state helpers.
 *
 * Every read and write is wrapped in try/catch: Safari private mode and
 * locked-down enterprise browser profiles throw on `localStorage` access
 * rather than returning null, and a throwing preference read must never be
 * allowed to take a page down.
 */

import { useCallback, useEffect, useState } from 'react';

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* preference is best-effort only */
  }
}

/** Boolean preference persisted under `key`. */
export function usePersistedBoolean(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const raw = readStored(key);
    if (raw === null) return fallback;
    return raw === 'true';
  });

  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        writeStored(key, String(resolved));
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}

/**
 * String preference persisted under `key`, constrained to `allowed`. A stored
 * value that is no longer a legal option (an option we renamed or dropped in a
 * later release) falls back rather than putting the UI into a dead state.
 */
export function usePersistedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readStored(key);
    return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeStored(key, next);
    },
    [key],
  );

  return [value, set];
}

/** Width in px above which the workspace uses its roomier `wide` layout. */
export const LAYOUT_BREAKPOINT_PX = 1500;

export type LayoutProfile = 'compact' | 'wide';

/**
 * Current layout profile. Resize is debounced so a drag across the breakpoint
 * does not rerender every consumer on each intermediate frame.
 */
export function useLayoutProfile(): LayoutProfile {
  const [profile, setProfile] = useState<LayoutProfile>(() =>
    typeof window !== 'undefined' && window.innerWidth >= LAYOUT_BREAKPOINT_PX ? 'wide' : 'compact',
  );

  useEffect(() => {
    let frame: number | undefined;
    const handle = () => {
      if (frame !== undefined) window.clearTimeout(frame);
      frame = window.setTimeout(() => {
        setProfile(window.innerWidth >= LAYOUT_BREAKPOINT_PX ? 'wide' : 'compact');
      }, 120);
    };
    window.addEventListener('resize', handle);
    return () => {
      if (frame !== undefined) window.clearTimeout(frame);
      window.removeEventListener('resize', handle);
    };
  }, []);

  return profile;
}

export interface PaneWidthOptions {
  /** Default width for the `compact` layout profile. */
  compact: number;
  /** Default width for the `wide` layout profile. */
  wide: number;
  min: number;
  /** Fixed cap in px, or a function of window width for proportional caps. */
  max: number | ((windowWidth: number) => number);
}

/**
 * A pane width the user can drag, remembered per layout profile.
 *
 * Compact and wide store separately because they are different working
 * postures: a width chosen on a laptop is not the width you want on a
 * 34" display, and sharing one value means every profile switch feels wrong.
 * The stored value is always re-clamped on read, so a width saved on a large
 * monitor cannot leave the pane wider than a smaller window when reopened.
 */
export function usePersistedPaneWidth(
  paneId: string,
  options: PaneWidthOptions,
): [number, (next: number) => void] {
  const profile = useLayoutProfile();
  const key = `kh_pane_${paneId}_${profile}`;

  const clamp = useCallback(
    (value: number) => {
      const viewport = typeof window === 'undefined' ? options.min : window.innerWidth;
      const max = typeof options.max === 'function' ? options.max(viewport) : options.max;
      return Math.min(Math.max(value, options.min), Math.max(max, options.min));
    },
    [options],
  );

  const fallback = profile === 'wide' ? options.wide : options.compact;
  const [width, setWidth] = useState<number>(() => {
    const raw = readStored(key);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return clamp(Number.isFinite(parsed) ? parsed : fallback);
  });

  // Re-read on profile change so each posture recalls its own width rather
  // than inheriting whatever the other one was last dragged to.
  useEffect(() => {
    const raw = readStored(key);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    setWidth(clamp(Number.isFinite(parsed) ? parsed : fallback));
  }, [key, fallback, clamp]);

  const set = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      setWidth(clamped);
      writeStored(key, String(clamped));
    },
    [key, clamp],
  );

  return [width, set];
}
