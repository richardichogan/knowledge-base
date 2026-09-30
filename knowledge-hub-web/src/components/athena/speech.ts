/**
 * components/athena/speech.ts — voice input/output helpers for Athena:
 * WAV encoding for speech-to-text uploads and turning markdown replies into
 * natural text for text-to-speech.
 */

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, (samples[i] ?? 0) * 32768));
  }
  const dataLen = pcm.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const le = true;
  v.setUint32(0, 0x52494646, false); // 'RIFF'
  v.setUint32(4, 36 + dataLen, le);
  v.setUint32(8, 0x57415645, false); // 'WAVE'
  v.setUint32(12, 0x666d7420, false); // 'fmt '
  v.setUint32(16, 16, le);
  v.setUint16(20, 1, le);
  v.setUint16(22, 1, le);
  v.setUint32(24, sampleRate, le);
  v.setUint32(28, sampleRate * 2, le);
  v.setUint16(32, 2, le);
  v.setUint16(34, 16, le);
  v.setUint32(36, 0x64617461, false); // 'data'
  v.setUint32(40, dataLen, le);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error as Error);
    reader.readAsDataURL(blob);
  });
}

// Converts an ISO YYYY-MM-DD date to a natural spoken form, e.g. "29 April
// 2026" instead of reading out each digit group. Falls back to the raw
// string if it doesn't parse as a real date.
function formatDateForSpeech(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

// Strip markdown syntax before TTS so voice replies read as clean, natural
// prose. Also drops IDs/URLs — those are useful to see on screen but tedious
// and unhelpful to hear read aloud; the spoken reply should stick to the
// salient points (status, priority, due date, etc.).
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*(ID|Url|URL|Link)\s*:.*$/gim, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    // ISO dates (e.g. "2026-04-29") → natural spoken date. Must run before
    // the slug un-concatenation below, or the hyphens here would just get
    // split into "2026 04 29" instead of a real date.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (iso) => formatDateForSpeech(iso))
    // Slugs like "ibm-thought-leadership" or paths like "owner/repo" read as
    // one garbled run-on word — split hyphens/underscores/slashes into
    // separate words so project and repo names are actually intelligible.
    .replace(/\b[a-zA-Z0-9]+(?:[-_/][a-zA-Z0-9]+)+\b/g, (slug) => slug.replace(/[-_/]/g, ' '))
    .replace(/&/g, ' and ')
    .replace(/[—–]/g, ', ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, '')
    .replace(/[!?]{2,}/g, (m) => m.charAt(0))
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .replace(/\.\s*\.\s*/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// First spoken chunk is kept short so audio starts quickly; the rest is
// synthesised in larger chunks while the first one plays.
const FIRST_SPEECH_CHUNK_CHARS = 160;
const SPEECH_CHUNK_CHARS = 600;

/** Splits text into sentence-aligned chunks for progressive speech. */
export function splitForSpeech(text: string): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)/g)?.map((s) => s.trim()).filter((s) => s !== '') ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const limit = chunks.length === 0 ? FIRST_SPEECH_CHUNK_CHARS : SPEECH_CHUNK_CHARS;
    if (current !== '' && current.length + sentence.length + 1 > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current === '' ? sentence : `${current} ${sentence}`;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}
