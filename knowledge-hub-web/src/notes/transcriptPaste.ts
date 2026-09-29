/**
 * notes/transcriptPaste.ts — recognises a meeting transcript pasted from
 * Microsoft Teams and turns it into one block per speaker turn.
 *
 * Teams puts HTML on the clipboard that BlockNote flattens into a single
 * paragraph ("Tomasik, Jaroslaw 09:30 One more point… KV, Ramachandran 09:30
 * MM. …"), losing every line break. The plain-text flavour keeps the
 * structure, so we parse that instead:
 *
 *   Tomasik, Jaroslaw   09:30          ← speaker + time on their own line
 *   One more point about indirect PO…  ← what they said (one or more lines)
 *
 * Also accepts "[09:30] Tomasik, Jaroslaw" and "Tomasik, Jaroslaw 0:05:12".
 */

export interface TranscriptEntry {
  speaker: string;
  time: string;
  text: string;
}

// "Name   09:30" / "Name 1:02:03" — a short line ending in a timestamp.
const SPEAKER_THEN_TIME = /^(.{2,80}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
// "[09:30] Name" / "09:30 Name" on its own line.
const TIME_THEN_SPEAKER = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(.{2,80})$/;

function matchSpeakerLine(line: string): { speaker: string; time: string } | null {
  const a = SPEAKER_THEN_TIME.exec(line);
  if (a) return { speaker: a[1]!.trim(), time: a[2]! };
  const b = TIME_THEN_SPEAKER.exec(line);
  // Only treat "09:30 something" as a speaker line when it's name-like (short, no sentence punctuation).
  if (b && b[2]!.split(/\s+/).length <= 5 && !/[.?!]$/.test(b[2]!)) return { speaker: b[2]!.trim(), time: b[1]! };
  return null;
}

/**
 * Parses pasted plain text as a transcript. Returns null unless it clearly
 * is one (at least two speaker lines, each followed by something said), so
 * ordinary pastes are never rewritten.
 */
export function parseTranscript(plain: string): TranscriptEntry[] | null {
  const lines = plain.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const entries: TranscriptEntry[] = [];
  let current: { speaker: string; time: string; text: string[] } | null = null;
  let preamble = 0;

  for (const line of lines) {
    if (line === '') continue;
    const speakerLine = matchSpeakerLine(line);
    if (speakerLine !== null) {
      if (current !== null) entries.push({ speaker: current.speaker, time: current.time, text: current.text.join(' ') });
      current = { ...speakerLine, text: [] };
    } else if (current !== null) {
      current.text.push(line);
    } else {
      preamble += 1; // lines before the first speaker (e.g. a meeting title)
    }
  }
  if (current !== null) entries.push({ speaker: current.speaker, time: current.time, text: current.text.join(' ') });

  const withText = entries.filter((e) => e.text !== '');
  if (withText.length < 2 || preamble > 3) return null;
  return withText;
}

/** BlockNote blocks for a parsed transcript: a bold "Speaker · time" line, then what they said. */
export function transcriptToBlocks(entries: TranscriptEntry[]): object[] {
  return entries.flatMap((e) => [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: e.speaker, styles: { bold: true } },
        { type: 'text', text: `  ${e.time}`, styles: { textColor: 'gray' } },
      ],
    },
    { type: 'paragraph', content: e.text },
  ]);
}
