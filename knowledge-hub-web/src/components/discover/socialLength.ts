export const SHORT_POST_LIMIT = 280;
export const BLUESKY_POST_LIMIT = 300;

/** Bluesky counts graphemes of the full text, which here is the copy, a blank line and the link. */
export function blueskyLength(post: string, url: string | null): number {
  const text = [post.trim(), url].filter(Boolean).join('\n\n');
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;
}

export function socialLength(post: string, url: string | null): number {
  const weight = (value: string): number => Array.from(value.normalize('NFC')).reduce((total, character) => {
    const code = character.codePointAt(0)!;
    return total + (code <= 0x10ff || (code >= 0x2000 && code <= 0x200d)
      || (code >= 0x2010 && code <= 0x201f) || (code >= 0x2032 && code <= 0x2037) ? 1 : 2);
  }, 0);
  // Conservatively count the full URL for Bluesky and at least X's 23-character link.
  const text = post.trim();
  const extraLinks = [...text.matchAll(/https?:\/\/[^\s]+/g)].reduce((total, match) => total + Math.max(0, 23 - weight(match[0])), 0);
  return Math.max(Array.from(text).length, weight(text) + extraLinks) + (url ? 2 + Math.max(23, weight(url)) : 0);
}
