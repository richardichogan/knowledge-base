import { createHash } from 'node:crypto';

const SECRET_KEY = /(secret|token|password|passwd|apikey|api_key|authorization|credential|canary|blob|base64|private_key|connection_?string|sas)/i;

/** Redact secret-like substrings from untrusted text before it reaches the model. */
export function sanitizeText(input: string): string {
  return input
    .replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi, '[redacted-data-uri]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]')
    .replace(/\bAccountKey=[^;\s]+/gi, 'AccountKey=[redacted]')
    .replace(/secret-canary[A-Za-z0-9_-]*/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9+/]{200,}={0,2}/g, '[redacted-blob]');
}

/** Strip userinfo and token-like query params from a URL; null when unusable. */
export function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key) || /^(sig|se|sp|sv|st|key|code)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

const METADATA_ALLOWLIST = [
  'path', 'repo', 'repository', 'publisher', 'author', 'state', 'extractionState', 'contentType',
  'contentKind', 'hasTranscript', 'truncated', 'language', 'channel', 'duration', 'status', 'kind',
] as const;

/** Only allowlisted scalar metadata keys survive; values are sanitised. */
export function projectMetadata(metadata: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (typeof metadata !== 'object' || metadata === null) return out;
  const source = metadata as Record<string, unknown>;
  for (const key of METADATA_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string') out[key] = sanitizeText(value).slice(0, MAX_VALUE_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, VERSION_HEX_CHARS);
}

export const DEFAULT_PAGE_CHARS = 6_000;
export const MAX_PAGE_CHARS = 12_000;
export const MAX_OFFSET = 100_000_000;

const MAX_VALUE_CHARS = 300;
const VERSION_HEX_CHARS = 32;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const BREAK_SEARCH_FRACTION = 0.75;

function isHigh(code: number): boolean { return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX; }
function isLow(code: number): boolean { return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX; }

/**
 * Returns the exclusive end offset of the page starting at `start`. Never splits a surrogate pair
 * and prefers a paragraph or line break in the last quarter of the page.
 */
export function pageEnd(text: string, start: number, maxChars: number): number {
  if (start + maxChars >= text.length) return text.length;
  let end = start + maxChars;
  const floor = start + Math.floor(maxChars * BREAK_SEARCH_FRACTION);
  const nl = text.lastIndexOf('\n', end - 1);
  if (nl >= floor) end = nl + 1;
  if (isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end -= 1;
  return end > start ? end : Math.min(text.length, start + maxChars + 1);
}

/** Snap an arbitrary offset off the middle of a surrogate pair. */
export function snapOffset(text: string, offset: number): number {
  if (offset > 0 && offset < text.length && isLow(text.charCodeAt(offset)) && isHigh(text.charCodeAt(offset - 1))) return offset - 1;
  return offset;
}
