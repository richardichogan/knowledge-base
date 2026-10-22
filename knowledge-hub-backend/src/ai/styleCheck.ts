/**
 * ai/styleCheck.ts — Post-draft check for AI writing tropes that the house style bans.
 * Dashes are fixed mechanically; the rest are reported so the draft can be regenerated or flagged.
 */

const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Replaces em/en dashes used as punctuation with commas; number ranges become "to". */
export function fixDashes(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[—–]\s*([.,;:!?)])/g, '$1')
    .replace(/(^|[>(\n])\s*[—–]\s*/g, '$1')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+-{1,2}\s+/g, ', ')
    .replace(/,\s*,/g, ',');
}

const TROPES: Array<{ label: string; pattern: RegExp }> = [
  { label: '"not X, it\'s Y" construction', pattern: /\b(?:it|this|that|the \w+)(?:['’]s| is| was) not\b[^.!?]{1,80}[.,;:]\s*(?:it|this|that|they)(?:['’]s| is| was| are)\b/i },
  { label: '"isn\'t X, it\'s Y" construction', pattern: /\b(?:isn['’]t|aren['’]t|wasn['’]t)\b[^.!?]{1,80}[.,;:]\s*(?:it|this|that|they)(?:['’]s|['’]re| is| are| was)\b/i },
  { label: '"not just X but Y" construction', pattern: /\bnot (?:just|only|merely|simply)\b[^.!?]{1,80}\b(?:but|it['’]s|it is)\b/i },
  { label: '"less about X, more about Y" construction', pattern: /\bless about\b[^.!?]{1,80}\bmore about\b/i },
  { label: '"done well / done badly" mirror', pattern: /\bdone (?:well|right|badly|poorly|wrong)\b/i },
  { label: 'rhythmic triplet of fragments', pattern: /(?:^|[.!?]\s)(?:\S+(?:\s\S+){0,2}[.!?]\s){2}\S+(?:\s\S+){0,2}[.!?](?:\s|$)/ },
  { label: 'rhythmic triplet ending a sentence', pattern: /\b[a-z]+, [a-z]+,? and [a-z]+[.!?](?:\s|$)/ },
  { label: 'vague mass attribution', pattern: /\b(?:most|many) (?:organisations|organizations|companies|enterprises|businesses|teams|leaders)\b/i },
  { label: '"resonates"', pattern: /\bresonat\w*/i },
  { label: '"worth noting/flagging/sitting with"', pattern: /\bworth (?:noting|flagging|sitting with|mentioning)\b/i },
  { label: '"lands" framing', pattern: /\b(?:the (?:part|bit)|what) (?:that )?lands\b/i },
  { label: '"signal" as a mass noun', pattern: /\b(?:useful|real|strong|clear|some|more|less|no|enough) signal\b|\bthere(?:['’]s| is) signal\b/i },
  { label: 'stock AI phrasing', pattern: /\b(?:delve\w*|tapestry|game[- ]changer|in today['’]s (?:fast-paced|digital|ever)|navigat\w+ the complexit\w+|it['’]s important to note|here['’]s the thing|let that sink in|the real story|make no mistake|load[- ]bearing|double[- ]edged sword|testament to|underscores?|pivotal|paradigm shift|north star|ever[- ]evolving|in the realm of|at its core|seismic|table stakes|move the needle|unlock\w*|unleash\w*|seamless\w*|quietly|the kicker|the uncomfortable truth|the bottom line|in conclusion|ultimately|moreover|furthermore)\b/i },
  { label: 'set-up and reveal ("Here\'s the catch:", "The answer?")', pattern: /\b(?:here['’]s (?:the (?:catch|twist|kicker|rub|problem)|why|what)|the (?:answer|catch|twist|result|short version)\?|spoiler:)/i },
  { label: '"the question isn\'t X, it\'s Y" construction', pattern: /\bthe (?:real )?(?:question|issue|problem|point) (?:isn['’]t|is not)\b/i },
  { label: '"not because X, but because Y" construction', pattern: /\bnot because\b[^.!?]{1,80}\bbut because\b/i },
  { label: '"this matters because" signposting', pattern: /\b(?:this|that|and that|which is why this) matters\b|\bwhy (?:this|it) matters\b/i },
  { label: 'em or en dash', pattern: /[—–]/ },
];

/** Returns the labels of every banned trope found in the given texts (HTML is stripped). */
export function findTropes(...texts: string[]): string[] {
  const text = texts.map(plain).join('\n');
  return TROPES.filter(t => t.pattern.test(text)).map(t => t.label);
}
