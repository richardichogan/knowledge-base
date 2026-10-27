import { randomUUID } from 'node:crypto';
import { object, text } from '../jobs/contracts.js';
import { ValidationError } from '../types/errors.js';
import { composeBlueskyText } from '../integrations/social/bluesky.js';
import { composeLinkedInText } from '../integrations/social/linkedin.js';
import { parsePublishBody, type BlogPublishBody } from '../services/blogPublisher.js';
import { parseNoteContent } from '../utils/noteContent.js';
import { localClock } from '../jobs/schedule.js';
import { MS_PER_HOUR } from '../config/constants.js';
import { PUBLISH_LIMITS, type Delivery, type Destination } from './contracts.js';

export const EPISODE_PLATFORMS = ['youtube', 'spotify', 'apple'] as const;
export type EpisodePlatform = typeof EPISODE_PLATFORMS[number];
export type EpisodeLinks = Record<EpisodePlatform, string>;
export const EPISODE_LABELS: Record<EpisodePlatform, string> = { youtube: 'YouTube', spotify: 'Spotify', apple: 'Apple Podcasts' };
export const PODCAST_LIMITS = { posts: 80, source: 100_000, copy: 10_000, selectionTokens: 4000, messages: 30, message: 2000, date: 10, timestamp: 50, label: 250 } as const;
const MONTHS_PER_YEAR = 12;
export interface PodcastWindow { from: string; to: string }
export interface PodcastPost {
  id: string; destination: Destination; label: string; scheduledAt: string | null;
  copy: string; platform: EpisodePlatform | null; url: string | null; blog: BlogPublishBody | null;
}
export interface PodcastPlan {
  title: string; notes: string[]; excluded: string[]; posts: PodcastPost[];
  accounts: Record<Destination, string>; linkedinName: string;
  window?: PodcastWindow | null; followUp?: boolean;
}
export interface PodcastCampaign {
  noteId: string; revision: number; links: EpisodeLinks; plan: PodcastPlan | null; sourceRevision: number | null;
  state: 'draft' | 'approved' | 'paused'; approvedAt: string | null; error: string | null;
}
export interface PodcastCampaignDetail extends PodcastCampaign {
  deliveries: Delivery[]; issues: string[]; sourceChanged: boolean; automaticDelivery: boolean;
}

export function parseEpisodeLinks(value: unknown, required = false): EpisodeLinks {
  const input = object(value);
  const result: EpisodeLinks = { youtube: '', spotify: '', apple: '' };
  for (const platform of EPISODE_PLATFORMS) {
    const raw = text(input[platform] ?? '', `${EPISODE_LABELS[platform]} episode URL`);
    if (!raw && !required) continue;
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new ValidationError(`Enter the ${EPISODE_LABELS[platform]} episode URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new ValidationError(`${EPISODE_LABELS[platform]} requires an HTTPS episode link without credentials or a custom port.`);
    }
    const youtube = (url.hostname === 'youtu.be' && /^\/[\w-]{11}\/?$/.test(url.pathname))
      || (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)
        && ((url.pathname === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v') ?? ''))
          || /^\/(?:live|shorts)\/[\w-]{11}\/?$/.test(url.pathname)));
    const spotify = url.hostname === 'open.spotify.com' && /^\/(?:intl-[a-z]{2}\/)?episode\/[a-zA-Z0-9]+\/?$/.test(url.pathname);
    const apple = url.hostname === 'podcasts.apple.com' && /\/id\d+\/?$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get('i') ?? '');
    if (!(platform === 'youtube' ? youtube : platform === 'spotify' ? spotify : apple)) {
      throw new ValidationError(`Use a direct ${EPISODE_LABELS[platform]} episode link, not a show, channel or unrelated website.`);
    }
    result[platform] = url.href;
  }
  return result;
}

/** Only suggest an unambiguous episode URL; channel links and competing episodes are not guessed. */
export function episodeLinksFromNote(content: string): EpisodeLinks {
  const candidates = new Map<EpisodePlatform, Set<string>>(EPISODE_PLATFORMS.map(platform => [platform, new Set()]));
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/https:\/\/[^\s<>"\\]+/g)) {
        const url = match[0].replace(/[),.;\]]+$/, '');
        for (const platform of EPISODE_PLATFORMS) {
          try {
            const parsed = parseEpisodeLinks({ [platform]: url });
            candidates.get(platform)!.add(parsed[platform]);
          } catch (error) {
            if (!(error instanceof ValidationError)) throw error;
          }
        }
      }
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(parseNoteContent(content).blocks);
  return Object.fromEntries(EPISODE_PLATFORMS.map(platform => {
    const urls = candidates.get(platform)!;
    return [platform, urls.size === 1 ? [...urls][0]! : ''];
  })) as EpisodeLinks;
}

export function podcastIdentity(noteId: string, postId: string): string { return `podcast:${noteId}:${postId}`; }
export function podcastPostText(post: PodcastPost): string {
  return post.destination === 'bluesky' ? composeBlueskyText(post.copy, post.url) : post.destination === 'blog' ? post.blog?.content ?? '' : post.copy;
}
function messages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > PODCAST_LIMITS.messages) throw new ValidationError('Invalid campaign notes.');
  return value.map(item => text(item, 'campaign note', PODCAST_LIMITS.message));
}

export function parsePodcastWindow(value: unknown): PodcastWindow | null {
  if (value === undefined || value === null) return null;
  const input = object(value);
  const from = text(input.from, 'campaign start date', PODCAST_LIMITS.date);
  const to = text(input.to, 'campaign end date', PODCAST_LIMITS.date);
  for (const date of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, PODCAST_LIMITS.date) !== date) {
      throw new ValidationError('The campaign window needs valid calendar dates.');
    }
  }
  if (to < from) throw new ValidationError('The campaign end date must not precede its start date.');
  return { from, to };
}

export function parsePodcastPlan(value: unknown, links: EpisodeLinks, accounts: PodcastPlan['accounts'], linkedinName: string,
  options: { authored?: boolean; window?: PodcastWindow | null } = {}): PodcastPlan {
  const input = object(value);
  parseEpisodeLinks(links, true);
  if (!Array.isArray(input.posts) || !input.posts.length || input.posts.length > PODCAST_LIMITS.posts) {
    throw new ValidationError('The campaign must contain between 1 and 80 posts.');
  }
  const listeningLinks = EPISODE_PLATFORMS.map(platform => `${EPISODE_LABELS[platform]}: ${links[platform]}`).join('\n');
  const posts = input.posts.map((value): PodcastPost => {
    const item = object(value);
    const destination = item.destination;
    if (destination !== 'blog' && destination !== 'linkedin' && destination !== 'bluesky') throw new ValidationError('Unknown campaign destination.');
    const scheduledAt = item.scheduledAt === null ? null : text(item.scheduledAt, 'publication time', PODCAST_LIMITS.timestamp);
    if (scheduledAt !== null) {
      const parts = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(scheduledAt);
      const [, year, month, day] = parts ?? [];
      if (!parts || !Number.isFinite(Date.parse(scheduledAt)) || Number(month) < 1 || Number(month) > MONTHS_PER_YEAR
        || Number(day) < 1 || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()) {
        throw new ValidationError('Campaign dates must be valid calendar dates with an explicit time and timezone.');
      }
    }
    const label = text(item.label, 'post label', PODCAST_LIMITS.label);
    if (!label) throw new ValidationError('Each campaign post needs a label.');
    let copy = text(item.copy ?? '', 'post copy', PODCAST_LIMITS.copy);
    let blog: BlogPublishBody | null = null;
    const platform: EpisodePlatform | null = null;
    const url: string | null = null;
    if (destination === 'blog') {
      const body = object(item.blog);
      let html = text(body.content, 'blog content', PODCAST_LIMITS.source);
      const missing = EPISODE_PLATFORMS.filter(key => !html.includes(links[key]) && !html.includes(links[key].replaceAll('&', '&amp;')));
      if (missing.length) html += `<p>${missing.map(key => `<a href="${links[key].replaceAll('&', '&amp;')}">${EPISODE_LABELS[key]}</a>`).join(' | ')}</p>`;
      blog = parsePublishBody({ ...body, content: html, postType: 'podcast', status: 'published' }, options.authored === true);
      if (!blog.slug) throw new ValidationError('The launch blog needs a stable slug.');
      copy = '';
    } else {
      if (!copy) throw new ValidationError(`${label} has no post copy.`);
      if (/https?:\/\//i.test(copy)) throw new ValidationError(`${label}: keep listening URLs separate from the copy so the approved links are used exactly once.`);
      if (destination === 'linkedin') copy = options.authored ? `${copy}\n\n${listeningLinks}` : composeLinkedInText(`${copy}\n\n${listeningLinks}`, null);
      else if (!options.authored) composeBlueskyText(copy, null);
    }
    return { id: randomUUID(), destination, label, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null, copy, blog, platform, url };
  });
  posts.sort((a, b) => (a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity) - (b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity));
  let blueskyIndex = 0;
  for (const post of posts) if (post.destination === 'bluesky') {
    post.platform = EPISODE_PLATFORMS[blueskyIndex++ % EPISODE_PLATFORMS.length]!;
    post.url = links[post.platform];
    if (!options.authored) composeBlueskyText(post.copy, post.url);
  }
  const window = options.window ?? null;
  if (window) for (const post of posts) {
    if (!post.scheduledAt) continue;
    const day = localClock(new Date(post.scheduledAt), 'Europe/London').day;
    if (day < window.from || day > window.to) throw new ValidationError(`${post.label} falls outside the requested campaign window.`);
  }
  return { title: text(input.title, 'campaign title', PODCAST_LIMITS.label), notes: messages(input.notes), excluded: messages(input.excluded), posts, accounts, linkedinName,
    window, followUp: window !== null && !posts.some(post => post.destination === 'blog') };
}

export function podcastPlanIssues(plan: PodcastPlan | null, now = new Date()): string[] {
  if (!plan) return ['Prepare a campaign from the saved Show Notes first.'];
  const issues: string[] = [];
  const blogs = plan.posts.filter(post => post.destination === 'blog');
  if (!plan.followUp && blogs.length !== 1) issues.push('The campaign needs exactly one launch blog.');
  for (const destination of plan.followUp ? [] : ['linkedin', 'bluesky'] as const) {
    if (!plan.posts.some(post => post.destination === destination)) issues.push(`The campaign has no ${destination === 'linkedin' ? 'LinkedIn' : 'Bluesky'} posts.`);
  }
  const blogAt = blogs[0]?.scheduledAt ? Date.parse(blogs[0].scheduledAt) : null;
  const linkedinTimes = plan.posts.filter(post => post.destination === 'linkedin' && post.scheduledAt).map(post => Date.parse(post.scheduledAt!));
  const firstLinkedin = linkedinTimes.length ? Math.min(...linkedinTimes) : null;
  for (const post of plan.posts) {
    try {
      if (post.destination === 'bluesky') composeBlueskyText(post.copy, post.url);
      if (post.destination === 'linkedin') composeLinkedInText(post.copy, null);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(`${post.label}: ${error.message} The original copy has not been shortened.`);
    }
    if (!post.scheduledAt) { issues.push(`${post.label}: add a publication date and time to the Show Notes.`); continue; }
    const at = Date.parse(post.scheduledAt);
    if (at <= now.getTime()) issues.push(`${post.label}: the date is in the past. It will not be sent as a catch-up post on approval.`);
    if (post.destination !== 'blog' && blogAt !== null && at <= blogAt) issues.push(`${post.label}: schedule it after the launch blog.`);
    if (!plan.followUp && post.destination === 'bluesky' && firstLinkedin !== null && at <= firstLinkedin) issues.push(`${post.label}: schedule it after the first LinkedIn post.`);
  }
  for (const destination of ['linkedin', 'bluesky'] as const) {
    const posts = plan.posts.filter(post => post.destination === destination && post.scheduledAt).sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
    const spacing = destination === 'bluesky' ? PUBLISH_LIMITS.blueskySpacingHours : PUBLISH_LIMITS.linkedinSpacingHours;
    const cap = destination === 'bluesky' ? PUBLISH_LIMITS.blueskyCap : PUBLISH_LIMITS.linkedinCap;
    const counts = new Map<string, number>();
    posts.forEach((post, index) => {
      const date = new Date(post.scheduledAt!);
      const prior = posts[index - 1];
      if (prior && date.getTime() - Date.parse(prior.scheduledAt!) < spacing * MS_PER_HOUR) issues.push(`${post.label}: leave at least ${spacing} hours between ${destination} posts.`);
      const day = localClock(date, 'Europe/London').day;
      counts.set(day, (counts.get(day) ?? 0) + 1);
    });
    for (const [day, count] of counts) if (count > cap) issues.push(`${day}: ${destination} exceeds the daily limit of ${cap}.`);
  }
  return issues;
}
