/** Exact, case-sensitive matching for "replace every occurrence" note edits. Shared by the backend checks and the live editor. */

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

export function nextMatch(text: string, find: string, wholeWord: boolean, from = 0): number {
  if (find === '') return -1;
  for (let at = text.indexOf(find, from); at >= 0; at = text.indexOf(find, at + 1)) {
    if (!wholeWord) return at;
    const before = text[at - 1];
    const after = text[at + find.length];
    if (!(before !== undefined && WORD_CHARACTER.test(before)) && !(after !== undefined && WORD_CHARACTER.test(after))) return at;
  }
  return -1;
}

export function replaceMatches(text: string, find: string, replacement: string, wholeWord: boolean): { text: string; count: number } {
  let out = '';
  let from = 0;
  let count = 0;
  for (let at = nextMatch(text, find, wholeWord, 0); at >= 0; at = nextMatch(text, find, wholeWord, from)) {
    out += text.slice(from, at) + replacement;
    from = at + find.length;
    count++;
  }
  return { text: out + text.slice(from), count };
}
