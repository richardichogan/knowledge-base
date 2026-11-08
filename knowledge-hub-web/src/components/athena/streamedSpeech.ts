import { stripMarkdownForSpeech } from './speech';

let lastSpeechId = 0;

/** A unique, increasing id for one spoken piece, so later pieces can be cancelled. */
export function nextSpeechId(): number {
  lastSpeechId += 1;
  return lastSpeechId;
}

/** Plain text to say for markdown, with any unpaired markdown symbols removed. */
export function speechText(markdown: string): string {
  return stripMarkdownForSpeech(markdown).replace(/[*_`#]+/g, '').replace(/\s{2,}/g, ' ').trim();
}

/** The part of a streaming reply made of finished sentences or lines, outside any open code block. */
export function completedSentences(markdown: string): string {
  let text = markdown;
  const fences = text.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) text = text.slice(0, text.lastIndexOf('```'));
  let end = 0;
  for (const match of text.matchAll(/[.!?]["')\]*_]*(?=\s)|\n/g)) end = match.index + match[0].length;
  return text.slice(0, end);
}

export interface SpeechOutput {
  speak: (text: string, id: number) => void;
  /** Cancels the piece with this id and everything queued after it. */
  cancelFrom: (id: number) => void;
}

/**
 * Speaks a reply sentence by sentence while it streams. Streamed text is
 * provisional: if it is reset, Athena waits; if it is rewritten, she stops and
 * speaks again from the first sentence that changed.
 */
export class StreamedSpeech {
  private pieces: Array<{ text: string; id: number }> = [];
  private silenced = false;
  private readonly output: SpeechOutput;

  constructor(output: SpeechOutput) {
    this.output = output;
  }

  /** The reply streamed so far (markdown). */
  update(markdown: string): void {
    this.sync(speechText(completedSentences(markdown)), false);
  }

  /** The accepted reply, as it should be spoken in full. */
  finish(spoken: string): void {
    this.sync(spoken, true);
  }

  /** Stops everything this reply has queued or is saying. */
  cancel(): void {
    const first = this.pieces[0];
    if (first) this.output.cancelFrom(first.id);
    this.pieces = [];
  }

  /** He interrupted or pressed stop: say nothing more of this reply. */
  silence(): void {
    this.cancel();
    this.silenced = true;
  }

  private sync(text: string, final: boolean): void {
    if (this.silenced) return;
    const said = this.pieces.map(piece => piece.text).join('');
    if (text.startsWith(said)) {
      this.say(text.slice(said.length));
      return;
    }
    // Reset for a tool round: wait for the new text to pass what was said.
    if (!final && said.startsWith(text)) return;
    let kept = 0;
    let length = 0;
    while (kept < this.pieces.length && text.startsWith(said.slice(0, length + this.pieces[kept]!.text.length))) {
      length += this.pieces[kept]!.text.length;
      kept += 1;
    }
    this.output.cancelFrom(this.pieces[kept]!.id);
    this.pieces = this.pieces.slice(0, kept);
    this.say(text.slice(length));
  }

  private say(rest: string): void {
    // One piece per sentence, so a rewrite re-speaks only from the sentence that changed.
    let carry = '';
    for (const sentence of rest.split(/(?<=[.!?]\s)/)) {
      const spoken = sentence.replace(/^[\s.,;:]+/, '').trim();
      if (spoken === '') {
        const last = this.pieces[this.pieces.length - 1];
        if (last) last.text += sentence;
        else carry += sentence;
        continue;
      }
      const id = nextSpeechId();
      this.pieces.push({ text: carry + sentence, id });
      carry = '';
      this.output.speak(spoken, id);
    }
  }
}
