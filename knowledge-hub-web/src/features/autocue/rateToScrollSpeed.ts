/**
 * rateToScrollSpeed.ts
 *
 * Maps syllables-per-second to pixels-per-second scroll speed,
 * calibrated to the current font size.
 */

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Below this syl/sec treat as silence — no scroll. */
export const SILENCE_THRESHOLD_SPS = 0.5;
/**
 * Approximate syllables per line of script text.
 * Lower = faster scroll. Tune this first when calibrating speed.
 */
export const SYLLABLES_PER_LINE    = 3;
/** Line height as a multiple of font size. */
export const LINE_HEIGHT_RATIO     = 1.6;

// ── Mapping function ──────────────────────────────────────────────────────────

/**
 * @param syllablesPerSecond  Current detected speech rate
 * @param baseFontSize        Current font size in px (e.g. 64)
 * @returns Scroll speed in pixels per second
 */
export function rateToScrollSpeed(
  syllablesPerSecond: number,
  baseFontSize: number,
): number {
  if (syllablesPerSecond < SILENCE_THRESHOLD_SPS) return 0;

  const linePixels  = baseFontSize * LINE_HEIGHT_RATIO;
  const linesPerSec = syllablesPerSecond / SYLLABLES_PER_LINE;
  return linesPerSec * linePixels;
}
