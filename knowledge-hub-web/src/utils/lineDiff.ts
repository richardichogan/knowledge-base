/**
 * utils/lineDiff.ts — a line-by-line comparison of two texts (longest common
 * subsequence), for showing what changed between versions of an output.
 */

export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
}

/** Above this many line pairs the comparison is skipped (shown as all replaced). */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ type: 'removed' as const, text })), ...b.map((text) => ({ type: 'added' as const, text }))];
  }
  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: 'removed', text: a[i]! });
      i += 1;
    } else {
      out.push({ type: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ type: 'added', text: b[j++]! });
  return out;
}
