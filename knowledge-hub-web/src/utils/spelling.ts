/**
 * Spelling suggestions for Athena's own right-click menu.
 *
 * The browser draws the red underline, but it only reveals a misspelling after
 * its own menu has been chosen, so Athena checks the right-clicked word itself
 * against a bundled en-GB dictionary that is downloaded the first time it is
 * needed (editable text gaining focus preloads it).
 */
import type NSpell from 'nspell';
// The dictionary package only exports its Node loader, so reference the files directly.
import affUrl from '../../node_modules/dictionary-en-gb/index.aff?url';
import dicUrl from '../../node_modules/dictionary-en-gb/index.dic?url';

const MAX_SUGGESTIONS = 6;
const WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u;

let checker: Promise<NSpell> | null = null;
let loaded: NSpell | null = null;

/** True when `text` is a single word that can have spelling suggestions. */
export function isSpellableWord(text: string): boolean {
  return text.length >= 2 && text.length <= 60 && WORD.test(text);
}

/** Starts loading the dictionary; safe to call repeatedly. */
export function loadSpelling(): Promise<NSpell> {
  checker ??= (async () => {
    const [{ default: nspell }, aff, dic] = await Promise.all([
      import('nspell'),
      fetch(affUrl).then((r) => { if (!r.ok) throw new Error(`Dictionary failed to load (${r.status})`); return r.text(); }),
      fetch(dicUrl).then((r) => { if (!r.ok) throw new Error(`Dictionary failed to load (${r.status})`); return r.text(); }),
    ]);
    loaded = nspell(aff, dic);
    return loaded;
  })();
  checker.catch(() => { checker = null; });
  return checker;
}

/**
 * True/false once the dictionary has loaded; null before then. Words written in
 * capitals or containing digits are treated as names/acronyms, never misspelt.
 */
export function isMisspelled(word: string): boolean | null {
  if (!loaded) return null;
  if (!isSpellableWord(word) || (word.length > 1 && word === word.toUpperCase())) return false;
  const plain = word.replace(/’/g, "'");
  return !loaded.correct(plain) && !loaded.correct(plain.toLowerCase());
}

/** Suggestions for `word`, keeping its capitalisation. Empty when the dictionary has none. */
export async function spellingSuggestions(word: string): Promise<string[]> {
  const spell = await loadSpelling();
  const apostrophe = word.includes('’');
  const plain = word.replace(/’/g, "'");
  const out: string[] = [];
  for (const raw of spell.suggest(plain)) {
    const s = matchCase(apostrophe ? raw.replace(/'/g, '’') : raw, word);
    if (s !== word && !out.includes(s)) out.push(s);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

function matchCase(suggestion: string, original: string): string {
  if (original.length > 1 && original === original.toUpperCase()) return suggestion.toUpperCase();
  const first = original.charAt(0);
  if (first !== first.toLowerCase()) return suggestion.charAt(0).toUpperCase() + suggestion.slice(1);
  return suggestion;
}
