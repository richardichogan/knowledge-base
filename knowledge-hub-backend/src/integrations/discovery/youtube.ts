import { fetchPublic, decodeEntities, type FeedArticle } from './feedReader.js';
import { ValidationError } from '../../types/errors.js';
import { playerFromPage, readYouTubeText, retrieveCaptions, type YouTubeTranscript } from './youtubeCaptions.js';

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;
const MAX_PAGE_BYTES = 3_000_000;
const MAX_TITLE_CHARS = 500;
const MAX_CHANNEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 20_000;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; AthenaFeedReader/1.0)', Accept: 'text/html' };
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

export function youtubeUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!HOSTS.has(url.hostname)) return null;
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new ValidationError('Use an HTTPS YouTube URL without login details or a custom port.');
  }
  return url;
}

export function youtubeVideoId(raw: string): string | null {
  const url = youtubeUrl(raw);
  if (!url) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const id = url.hostname === 'youtu.be' ? parts[0]
    : url.pathname === '/watch' ? url.searchParams.get('v')
      : ['shorts', 'live', 'embed'].includes(parts[0] ?? '') ? parts[1] : null;
  return id && VIDEO_ID.test(id) ? id : null;
}

async function page(url: string): Promise<string> {
  const response = await fetchPublic(url, { headers: HEADERS, timeoutMs: 20_000 });
  if (!response.ok || !response.body) throw new ValidationError(`YouTube could not be read (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '', bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PAGE_BYTES) throw new ValidationError('The YouTube page is too large to read safely.');
      html += decoder.decode(chunk.value, { stream: true });
    }
    return html + decoder.decode();
  } finally { await reader.cancel(); }
}

export function channelIdFromPage(html: string): string {
  const id = /"channelMetadataRenderer"\s*:\s*\{[^}]*"externalId"\s*:\s*"(UC[\w-]{22})"/.exec(html)?.[1]
    ?? /<link\b[^>]*href=["']https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[\w-]{22})["']/i.exec(html)?.[1];
  if (!id) throw new ValidationError('Could not resolve that YouTube channel. Try its /channel/UC… URL.');
  return id;
}

export async function resolveDiscoveryFeed(raw: string): Promise<string> {
  const url = youtubeUrl(raw);
  if (!url) return raw;
  if (url.pathname === '/feeds/videos.xml' && CHANNEL_ID.test(url.searchParams.get('channel_id') ?? '')) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${url.searchParams.get('channel_id')}`;
  }
  if (youtubeVideoId(raw)) throw new ValidationError('Use Add video for an individual video, or enter a channel URL here.');
  const parts = url.pathname.split('/').filter(Boolean);
  let id = parts[0] === 'channel' && CHANNEL_ID.test(parts[1] ?? '') ? parts[1] : undefined;
  if (!id) {
    const channelPath = parts[0]?.startsWith('@') ? parts[0]
      : ['c', 'user'].includes(parts[0] ?? '') && parts[1] ? `${parts[0]}/${parts[1]}` : null;
    if (!channelPath) throw new ValidationError('Enter a YouTube channel URL, such as https://www.youtube.com/@MicrosoftAzure.');
    id = channelIdFromPage(await page(`https://www.youtube.com/${channelPath}`));
  }
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
}

export interface YouTubeVideo extends FeedArticle {
  channel: string; durationSeconds: number; videoId: string;
  transcript?: YouTubeTranscript;
}

export function videoFromPage(html: string, videoId: string): YouTubeVideo {
  let data: unknown;
  try { data = playerFromPage(html); } catch { throw new ValidationError('YouTube did not expose readable video details. The video may be private, restricted or unavailable.'); }
  if (!data || typeof data !== 'object' || !('videoDetails' in data)) throw new ValidationError('Video details are unavailable.');
  const details = data.videoDetails;
  if (!details || typeof details !== 'object' || !('title' in details) || typeof details.title !== 'string'
    || !('author' in details) || typeof details.author !== 'string'
    || !('videoId' in details) || details.videoId !== videoId) throw new ValidationError('Video details are incomplete.');
  const description = 'shortDescription' in details && typeof details.shortDescription === 'string' ? details.shortDescription : '';
  const duration = 'lengthSeconds' in details ? Number(details.lengthSeconds) : 0;
  const published = /"publishDate"\s*:\s*"([^"]+)"/.exec(html)?.[1];
  const date = published ? new Date(published) : null;
  return {
    videoId, title: decodeEntities(details.title).slice(0, MAX_TITLE_CHARS), channel: details.author.slice(0, MAX_CHANNEL_CHARS),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    summary: `YouTube video - description only; no transcript retrieved.\n\n${description.slice(0, MAX_DESCRIPTION_CHARS) || 'No description provided.'}`,
    publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
    durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration : 0,
  };
}

export async function readYouTubeVideo(raw: string): Promise<YouTubeVideo> {
  const id = youtubeVideoId(raw);
  if (!id) throw new ValidationError('Enter a valid YouTube video URL.');
  const html = await readYouTubeText(`https://www.youtube.com/watch?v=${id}`, MAX_PAGE_BYTES);
  const video = videoFromPage(html, id);
  const transcript = await retrieveCaptions(playerFromPage(html));
  if (transcript.status === 'retrieved') {
    video.summary = `${video.summary.replace('description only; no transcript retrieved.', 'description and public captions retrieved.')}\n\nPublic captions (${transcript.language}; ${transcript.automatic ? 'automatically generated; may contain errors' : 'authored'}${transcript.truncated ? '; truncated' : ''}):\n${transcript.text}`;
  }
  return { ...video, transcript };
}
