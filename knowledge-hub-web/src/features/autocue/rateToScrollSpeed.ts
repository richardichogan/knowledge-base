/**
 * rateToScrollSpeed.ts
 *
 * Maps syllables-per-second to pixels-per-second scroll speed,
 * calibrated to the current font size and the actual syllable density
 * of the loaded script.
 */

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Below this syl/sec treat as silence — no scroll. */
export const SILENCE_THRESHOLD_SPS = 1.0;
/** Line height as a multiple of font size. */
export const LINE_HEIGHT_RATIO = 1.6;
/**
 * Fallback syllables-per-line used only before the script has been measured.
 * Once the script renders, the real value is calculated from its content.
 */
export const DEFAULT_SYLLABLES_PER_LINE = 10;

// ── Syllable counter ──────────────────────────────────────────────────────────

/**
 * Counts syllables in a string using a simple vowel-group heuristic.
 * Good enough for teleprompter speed calibration.
 */
export function countSyllables(text: string): number {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  let total = 0;
  for (const word of words) {
    const stripped = word.replace(/e$/, '');
    const groups = stripped.match(/[aeiouy]+/g) ?? [];
    total += Math.max(1, groups.length);
  }
  return total;
}

// ── Mapping function ──────────────────────────────────────────────────────────

/**
 * @param syllablesPerSecond  Current detected speech rate
 * @param baseFontSize        Current font size in px (e.g. 64)
 * @param syllablesPerLine    Calculated from the actual script (syllables / rendered lines)
 * @returns Scroll speed in pixels per second
 */
export function rateToScrollSpeed(
  syllablesPerSecond: number,
  baseFontSize: number,
  syllablesPerLine: number = DEFAULT_SYLLABLES_PER_LINE,
): number {
  if (syllablesPerSecond < SILENCE_THRESHOLD_SPS) return 0;

  const linePixels  = baseFontSize * LINE_HEIGHT_RATIO;
  const linesPerSec = syllablesPerSecond / syllablesPerLine;
  return linesPerSec * linePixels;
}
