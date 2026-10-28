/**
 * ai/styleCheck.ts — Post-draft check for AI writing tropes that the house style bans.
 * Dashes are fixed mechanically; the rest are reported so the draft can be regenerated or flagged.
 */

const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Replaces em/en dashes used as punctuation with commas; number ranges become "to". */
export function fixDashes(text: string): string {
  return text.split(/(<a\b[^>]*>[\s\S]*?<\/a>|<blockquote\b[^>]*>[\s\S]*?<\/blockquote>|<q\b[^>]*>[\s\S]*?<\/q>|<[^>]*>|"[^"\n]+"|“[^”\n]+”|‘[^’\n]+’)/gi)
    .map(part => /^(?:<|"|“|‘)/.test(part) ? part : part
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[—–]\s*([.,;:!?)])/g, '$1')
    .replace(/(^|[>(\n])\s*[—–]\s*/g, '$1')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+-{1,2}\s+/g, ', ')
    .replace(/,\s*,/g, ',')).join('');
}

const TROPES: Array<{ label: string; pattern: RegExp }> = [
  { label: '"not X, it\'s Y" construction', pattern: /\b(?:is|was|are) not\b[^.!?]{1,120}[.,;:]\s*(?:it|this|that|they)(?:['’]s| is| was| are)\b/i },
  { label: '"isn\'t X, it\'s Y" construction', pattern: /\b(?:isn['’]t|aren['’]t|wasn['’]t)\b[^.!?]{1,80}[.,;:]\s*(?:it|this|that|they)(?:['’]s|['’]re| is| are| was)\b/i },
  { label: '"not just X but Y" construction', pattern: /\bnot (?:just|only|merely|simply)\b[^.!?]{1,80}\b(?:but|it['’]s|it is)\b/i },
  { label: '"less about X, more about Y" construction', pattern: /\bless about\b[^.!?]{1,80}\bmore about\b/i },
  { label: '"done well / done badly" mirror', pattern: /\bdone (?:well|right|badly|poorly|wrong)\b/i },
  { label: 'rhythmic triplet of fragments', pattern: /(?:^|[.!?]\s)(?:\S+(?:\s\S+){0,2}[.!?]\s){2}\S+(?:\s\S+){0,2}[.!?](?:\s|$)/ },
  // A single comma can introduce a clause containing a pair, not a three-item list.
  { label: 'triplet list', pattern: /\b[a-z][a-z'’-]*(?: [a-z][a-z'’-]*){0,3}, [a-z][a-z'’-]*(?: [a-z][a-z'’-]*){0,3}, (?:and|or) [a-z][a-z'’-]*(?: [a-z][a-z'’-]*){0,3}/i },
  { label: '"rather than / instead of" contrast', pattern: /\b(?:rather than|instead of)\b/i },
  { label: '"matters" signposting', pattern: /\b(?:also|really|still|which|this|that|it|what|why) matters\b|\bmatters (?:because|here|more|most)\b/i },
  { label: 'editorial throat-clearing', pattern: /\bmy (?:read|take|view|sense) (?:is|here)\b|\b(?:that|this) is (?:useful|important|significant|interesting|helpful) (?:for|because)\b|\bin (?:enterprise|practical|plain|real|business) terms\b|\bfairly simple\b|\bthe short version\b|\bput simply\b|\bin other words\b/i },
  { label: 'stock audience phrase', pattern: /\b(?:architects|IT leaders) and (?:architects|IT leaders)\b/i },
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

interface StyleOccurrence { label: string; text: string; field: number; block: number; start: number; end: number }

function styleOccurrences(texts: string[], article = false): StyleOccurrence[] {
  const patterns = article
    ? [...TROPES, { label: '"less like X, more like Y" construction', pattern: /\bless like\b[^.!?]{1,80}\bmore like\b/i }]
    : TROPES;
  return texts.map(text => text
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' citation ')
    .replace(/\[[^\n]*?\]\(https?:\/\/[^)\s]+\)/g, ' citation ')
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>|<q\b[^>]*>[\s\S]*?<\/q>/gi, ' quotation ')
    .replace(/"[^"\n]+"|“[^”\n]+”|‘[^’\n]+’/g, ' quotation '))
    .flatMap((text, field) => text.split(/<\/(?:p|h[1-6]|li)>|\n\s*\n/i).flatMap((blockText, block) =>
      patterns.flatMap(t => [...plain(blockText).matchAll(new RegExp(t.pattern.source, `${t.pattern.flags}g`))]
        .map(m => ({ label: t.label, text: m[0].trim(), field, block, start: m.index!, end: m.index! + m[0].length })))));
}

/** Returns every banned trope found in the given texts (HTML is stripped), each with the offending words quoted. */
export function findTropes(...texts: string[]): string[] {
  // Citation labels and quotations are not authored prose.
  return [...new Set(styleOccurrences(texts).map(item => `${item.label}: "${item.text}"`))];
}

/** Full articles permit occasional rhetorical patterns; substantive lists are reviewed in context. */
export function findBlogTropes(postType: string, ...texts: string[]): string[] {
  if (postType !== 'article') return findTropes(...texts);
  const occurrences = styleOccurrences(texts, true).filter(item =>
    item.label !== 'triplet list' && item.label !== '"rather than / instead of" contrast');
  const category = (label: string): 'triplet' | 'contrast' | undefined => {
    if (label === 'rhythmic triplet of fragments') return 'triplet';
    if (label === '"not X, it\'s Y" construction' || label === '"isn\'t X, it\'s Y" construction'
      || label === '"not just X but Y" construction' || label === '"the question isn\'t X, it\'s Y" construction'
      || label === '"not because X, but because Y" construction' || label === '"less about X, more about Y" construction'
      || label === '"less like X, more like Y" construction') return 'contrast';
    return undefined;
  };
  const allowed = new Set<StyleOccurrence>(occurrences.filter(item => category(item.label) && item.field !== 3));
  for (const kind of ['triplet', 'contrast'] as const) {
    const matches = occurrences.filter(item => category(item.label) === kind && item.field === 3)
      .sort((a, b) => a.field - b.field || a.block - b.block || a.start - b.start || b.end - a.end);
    let count = 0;
    let prior: StyleOccurrence | undefined;
    let end = -1;
    for (const item of matches) {
      if (!prior || item.field !== prior.field || item.block !== prior.block || item.start >= end) {
        count++;
        end = item.end;
      } else {
        end = Math.max(end, item.end);
      }
      if (count <= 2) allowed.add(item);
      prior = item;
    }
  }
  return [...new Set(occurrences.filter(item => !allowed.has(item)).map(item => `${item.label}: "${item.text}"`))];
}

/** A factual roundup needs enumerations; the voice reviewer judges rhetoric in context. */
export function findWeeklyTropes(...texts: string[]): string[] {
  return findTropes(...texts).filter(finding => !finding.startsWith('triplet list:'));
}
