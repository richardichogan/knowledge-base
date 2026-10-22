import { XMLParser } from 'fast-xml-parser';
import { decodeEntities, fetchPublic } from './feedReader.js';

const MAX_BYTES = 2_000_000;
const MAX_CHARS = 100_000;
const TIMEOUT_MS = 8_000;
const MS_PER_SECOND = 1_000;
const NON_ENGLISH_PENALTY = 2;

/** Public caption availability; failure never implies the video has no spoken content. */
export interface YouTubeTranscript {
  status: 'retrieved' | 'unavailable' | 'failed';
  text: string;
  language?: string;
  automatic?: boolean;
  truncated?: boolean;
}

/** Reads YouTube's embedded player data without evaluating page JavaScript. */
export function playerFromPage(html: string): Record<string, unknown> {
  const start = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/g.exec(html);
  if (!start) throw new Error('YouTube did not expose player data.');
  const offset = start.index + start[0].length;
  let quoted = false, escaped = false, depth = 0;
  for (let i = offset; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const value: unknown = JSON.parse(html.slice(offset, i + 1));
      if (!value || typeof value !== 'object' || Array.isArray(value)) break;
      return value as Record<string, unknown>;
    }
  }
  throw new Error('YouTube returned unreadable player data.');
}

/** Bounded network reads shared by public watch-page and caption retrieval. */
export async function readYouTubeText(url: string, maxBytes = MAX_BYTES): Promise<string> {
  const response = await fetchPublic(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AthenaFeedReader/1.0)', Accept: '*/*' }, timeoutMs: TIMEOUT_MS,
  });
  if (!response.ok || !response.body) throw new Error(`YouTube read failed (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let expired = false;
  const deadline = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, TIMEOUT_MS);
  let text = '', size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('YouTube response exceeds the safe size limit.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (expired) throw new Error('YouTube response timed out.');
    return text + decoder.decode();
  } finally { clearTimeout(deadline); await reader.cancel(); }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Parses public JSON3 or legacy XML timed text; keeps timestamps rather than inventing speech. */
export function captionText(raw: string): { text: string; truncated: boolean } {
  let lines: string[];
  if (raw.trimStart().startsWith('{')) {
    const data = object(JSON.parse(raw));
    if (!Array.isArray(data['events'])) throw new Error('YouTube captions have no events.');
    lines = data['events'].map((event: unknown) => {
      const e = object(event);
      if (!Array.isArray(e['segs'])) return '';
      const text = e['segs'].map((s: unknown) => object(s)['utf8']).filter((s): s is string => typeof s === 'string').join('').trim();
      const ms = Number(e['tStartMs']);
      return text ? `[${Number.isFinite(ms) ? (ms / MS_PER_SECOND).toFixed(1) : '?'}s] ${text}` : '';
    });
  } else {
    const doc = object(new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(raw));
    const entries = object(doc['transcript'])['text'];
    if (!entries) throw new Error('YouTube captions have no text.');
    lines = (Array.isArray(entries) ? entries : [entries]).map((entry: unknown) => {
      const e = object(entry);
      const text = typeof entry === 'string' ? entry : String(e['#text'] ?? '');
      return text.trim() ? `[${String(e['@_start'] ?? '?')}s] ${text}` : '';
    });
  }
  const text = decodeEntities(lines.filter(Boolean).join('\n')).trim();
  if (!text) throw new Error('YouTube returned empty captions.');
  return { text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}

/** Attempts one public track, preferring authored English then automatic English; no login/bypass. */
export async function retrieveCaptions(player: Record<string, unknown>, read = readYouTubeText): Promise<YouTubeTranscript> {
  const tracks = object(object(player['captions'])['playerCaptionsTracklistRenderer'])['captionTracks'];
  if (!Array.isArray(tracks) || tracks.length === 0) return { status: 'unavailable', text: '' };
  const candidates = tracks.map(object).filter(t => typeof t['baseUrl'] === 'string');
  candidates.sort((a, b) => {
    const rank = (t: Record<string, unknown>): number =>
      (String(t['languageCode']).startsWith('en') ? 0 : NON_ENGLISH_PENALTY) + (t['kind'] === 'asr' ? 1 : 0);
    return rank(a) - rank(b);
  });
  const track = candidates[0];
  if (!track) return { status: 'unavailable', text: '' };
  try {
    const url = new URL(String(track['baseUrl']));
    if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname)
      || url.pathname !== '/api/timedtext' || url.username || url.password || url.port) {
      throw new Error('YouTube supplied an unsupported caption address.');
    }
    url.searchParams.set('fmt', 'json3');
    return { status: 'retrieved', ...captionText(await read(url.toString())),
      language: String(track['languageCode'] ?? ''), automatic: track['kind'] === 'asr' };
  } catch {
    console.warn('[YouTube] Public caption retrieval failed; retaining description-only evidence.');
    return { status: 'failed', text: '' };
  }
}
