import { createHash, randomUUID } from 'node:crypto';
import { object, text } from '../jobs/contracts.js';
import { ValidationError } from '../types/errors.js';
import { composeBlueskyText } from '../integrations/social/bluesky.js';
import { composeLinkedInText } from '../integrations/social/linkedin.js';
import { parsePublishBody, type BlogPublishBody } from '../services/blogPublisher.js';
import { parseNoteContent } from '../utils/noteContent.js';
import { localClock } from '../jobs/schedule.js';
import type { Delivery, Destination } from './contracts.js';
import type { ScheduledPost } from './schedule.js';

export const EPISODE_PLATFORMS = ['youtube', 'spotify', 'apple'] as const;
export type EpisodePlatform = typeof EPISODE_PLATFORMS[number];
export type EpisodeLinks = Record<EpisodePlatform, string>;
export const EPISODE_LABELS: Record<EpisodePlatform, string> = { youtube: 'YouTube', spotify: 'Spotify', apple: 'Apple Podcasts' };
export const PODCAST_LIMITS = { posts: 80, source: 100_000, copy: 10_000, selectionTokens: 16000, messages: 30, message: 2000, date: 10, timestamp: 50, label: 250 } as const;
const MONTHS_PER_YEAR = 12;
const ASSET_TEXT_LIMITS = { headline: 500, quote: 1200, speaker: 100, timestamp: 20 } as const;
export interface PodcastWindow { from: string; to: string }
export interface PodcastPost {
  id: string; destination: Destination; label: string; scheduledAt: string | null;
  copy: string; platform: EpisodePlatform | null; url: string | null; blog: BlogPublishBody | null;
  sourceHash?: string;
  sourceCopy?: string;
  assetSpec?: PodcastAssetSpec;
  asset?: PodcastImageAsset;
}
export interface PodcastAssetSpec {
  kind: 'quote' | 'launch' | 'teaser' | 'fuller';
  headline: string; quote: string | null; speaker: string | null; timestamp: string | null;
  episodeNumber: number | null;
}
export interface PodcastImageAsset {
  imageId: string; url: string; width: number; height: number; alt: string; sourceHash: string; contentHash: string;
}
export function parsePodcastAssetSpec(value: unknown, episodeNumber: number | null): PodcastAssetSpec {
  const asset = object(value);
  const headline = text(asset.headline, 'image headline', ASSET_TEXT_LIMITS.headline);
  if (/^(?:\d+[a-z]?\s+)?(?:post[- ]recording\s+teas(?:e|er)|recording[- ]day|launch[- ]day|quote\s+cards?|social\s+(?:posts?|campaign)|titles\s+and\s+metadata)\b/i.test(headline)
    || /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+\d/i.test(headline)) {
    throw new ValidationError('Artwork needs the audience-facing episode title or topic, not an internal campaign section, date or channel label.');
  }
  const kind = asset.kind;
  if (kind !== 'quote' && kind !== 'launch' && kind !== 'teaser' && kind !== 'fuller') throw new ValidationError('Unknown podcast image type.');
  const quote = asset.quote === null ? null : text(asset.quote, 'image quote', ASSET_TEXT_LIMITS.quote);
  const speaker = asset.speaker === null ? null : text(asset.speaker, 'quote speaker', ASSET_TEXT_LIMITS.speaker);
  const timestamp = asset.timestamp === null ? null : text(asset.timestamp, 'quote timestamp', ASSET_TEXT_LIMITS.timestamp);
  if (kind === 'quote' && (!quote || !speaker || !/^(?:Richard|David|Cyrus)\b/i.test(speaker))) throw new ValidationError('Select the exact quote and its presenter from Show Notes.');
  if (timestamp && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(timestamp)) throw new ValidationError('Use the quote timestamp from the saved source.');
  return { kind, headline, quote, speaker, timestamp, episodeNumber };
}
export interface PodcastPlan {
  title: string; notes: string[]; excluded: string[]; posts: PodcastPost[];
  accounts: Record<Destination, string>; linkedinName: string;
  window?: PodcastWindow | null; followUp?: boolean;
  recordingTease?: boolean;
  transcriptUploadedAt?: string | null;
  assetsRequired?: boolean;
  reviewRequired?: boolean;
  sequenceRequired?: boolean;
  review?: PodcastCreationReview;
}
export interface PodcastCreationReview {
  status: 'pending' | 'pass' | 'fail';
  fingerprint: string; reviewer: string | null; checkedAt: string | null;
  findings: Array<{ postId: string | null; message: string }>;
}
export function podcastReviewFingerprint(plan: PodcastPlan): string {
  return createHash('sha256').update(JSON.stringify({
    title: plan.title, recordingTease: !!plan.recordingTease, accounts: plan.accounts,
    ...(plan.sequenceRequired && { sequenceRequired: true }),
    posts: plan.posts.map(post => ({
      id: post.id, destination: post.destination, copy: post.copy, sourceCopy: post.sourceCopy, url: post.url, blog: post.blog,
      scheduledAt: plan.recordingTease && post.scheduledAt ? localClock(new Date(post.scheduledAt), 'Europe/London').day : post.scheduledAt,
      assetSpec: post.assetSpec, asset: post.asset ? {
        imageId: post.asset.imageId, contentHash: post.asset.contentHash, sourceHash: post.asset.sourceHash,
        width: post.asset.width, height: post.asset.height, alt: post.asset.alt,
      } : null,
    })),
  })).digest('hex');
}
export function requirePodcastCreationReview(plan: PodcastPlan): void {
  plan.reviewRequired = true;
  plan.review = { status: 'pending', fingerprint: podcastReviewFingerprint(plan), reviewer: null, checkedAt: null, findings: [] };
}
export interface PodcastCampaign {
  noteId: string; revision: number; links: EpisodeLinks; plan: PodcastPlan | null; sourceRevision: number | null;
  state: 'draft' | 'approved' | 'paused'; approvedAt: string | null; error: string | null;
}
export interface PodcastCampaignDetail extends PodcastCampaign {
  deliveries: Delivery[]; issues: string[]; sourceChanged: boolean; automaticDelivery: boolean;
}
export interface ScheduledPodcastPost extends Omit<ScheduledPost, 'topicId'> {
  noteId: string; label: string; copy: string; blog: PodcastPost['blog'];
  campaignPaused: boolean; deliveryStatus: Delivery['status'] | null;
  asset?: PodcastImageAsset;
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
  options: { authored?: boolean; window?: PodcastWindow | null; recordingTease?: boolean; episodeNumber?: number | null } = {}): PodcastPlan {
  const input = object(value);
  parseEpisodeLinks(links, !options.recordingTease);
  if (!Array.isArray(input.posts) || !input.posts.length || input.posts.length > PODCAST_LIMITS.posts) {
    throw new ValidationError('The campaign must contain between 1 and 80 posts.');
  }
  const listeningLinks = EPISODE_PLATFORMS.map(platform => `${EPISODE_LABELS[platform]}: ${links[platform]}`).join('\n');
  const posts = input.posts.map((value): PodcastPost => {
    const item = object(value);
    const destination = item.destination;
    if (destination !== 'blog' && destination !== 'linkedin' && destination !== 'bluesky') throw new ValidationError('Unknown campaign destination.');
    if (options.recordingTease && destination === 'blog') throw new ValidationError('Recording teasers are social posts, not launch blogs.');
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
      if (destination === 'linkedin') {
        if (!options.recordingTease) copy = `${copy}\n\n${listeningLinks}`;
        if (!options.authored) copy = composeLinkedInText(copy, null);
      }
      else if (!options.authored) composeBlueskyText(copy, null);
    }
    let assetSpec: PodcastAssetSpec | undefined;
    if (item.asset !== undefined && item.asset !== null) {
      assetSpec = parsePodcastAssetSpec(item.asset, options.episodeNumber ?? null);
    }
    return { id: randomUUID(), destination, label, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null, copy, blog, platform, url,
      ...(assetSpec && { assetSpec }) };
  });
  posts.sort((a, b) => (a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity) - (b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity));
  let blueskyIndex = 0;
  for (const post of posts) if (post.destination === 'bluesky' && !options.recordingTease) {
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
    window, followUp: options.recordingTease || (window !== null && !posts.some(post => post.destination === 'blog')),
    ...(options.recordingTease && { recordingTease: true }) };
}

const CAMPAIGN_STAGES = { teaser: 0, launch: 1, blog: 2, followup: 3 } as const;
function podcastPostStage(post: PodcastPost): number {
  if (post.destination === 'blog') return CAMPAIGN_STAGES.blog;
  if (post.assetSpec?.kind === 'teaser') return CAMPAIGN_STAGES.teaser;
  if (post.assetSpec?.kind === 'launch') return CAMPAIGN_STAGES.launch;
  return CAMPAIGN_STAGES.followup;
}

export function comparePodcastPosts(a: PodcastPost, b: PodcastPost): number {
  return (a.scheduledAt ? Date.parse(a.scheduledAt) : Infinity) - (b.scheduledAt ? Date.parse(b.scheduledAt) : Infinity)
    || podcastPostStage(a) - podcastPostStage(b);
}

export function podcastSequenceIssues(plan: PodcastPlan, recordingTeaser?: PodcastPlan | null): string[] {
  if (!plan.sequenceRequired) return [];
  const issues: string[] = [];
  if (!plan.followUp && !plan.recordingTease) {
    if (!plan.posts.some(post => podcastPostStage(post) === CAMPAIGN_STAGES.launch)) issues.push('Add the episode launch post before approving this campaign.');
    if (!plan.posts.some(post => post.destination === 'blog')) issues.push('Add the blog post before approving this campaign.');
  }
  const posts = [...(recordingTeaser?.posts ?? []), ...plan.posts];
  for (const post of plan.posts) {
    if (!post.scheduledAt) continue;
    const earlierStage = posts.find(other => other.scheduledAt && podcastPostStage(other) < podcastPostStage(post)
      && Date.parse(other.scheduledAt) >= Date.parse(post.scheduledAt!));
    if (earlierStage) issues.push(`${post.label}: schedule it after ${earlierStage.label}. Required order: Teaser, Launch, Blog Post, then Quotes and fuller/generic posts. Correct the authored dates or times before approval; no dates were moved.`);
  }
  return issues;
}

export function podcastPlanIssues(plan: PodcastPlan | null, _now = new Date(), includeReview = true, recordingTeaser?: PodcastPlan | null): string[] {
  if (!plan) return ['Prepare a campaign from the saved Show Notes first.'];
  const issues: string[] = podcastSequenceIssues(plan, recordingTeaser);
  if (includeReview && plan.reviewRequired) {
    if (!plan.review || plan.review.status === 'pending') issues.push('Independent image and post review is pending. Approval is blocked until it passes.');
    else if (plan.review.status === 'fail') issues.push(...(plan.review.findings.length ? plan.review.findings.map(finding => {
      const post = plan.posts.find(post => post.id === finding.postId);
      return `${post ? `${post.label}: ` : ''}${finding.message}`;
    }) : ['Independent publication review failed. Approval remains blocked.']));
    else if (plan.review.status !== 'pass' || !plan.review.reviewer || plan.review.findings.length
      || plan.review.fingerprint !== podcastReviewFingerprint(plan)) issues.push('The posts or artwork changed after independent review. Review the current version before approval.');
  }
  for (const post of plan.posts) {
    if (plan.assetsRequired && !post.asset) issues.push(`${post.label}: its review image has not been generated.`);
    try {
      if (post.destination === 'bluesky') composeBlueskyText(post.copy, post.url);
      if (post.destination === 'linkedin') composeLinkedInText(post.copy, null);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(`${post.label}: ${error.message} The original copy has not been shortened.`);
    }
    if (!post.scheduledAt) { issues.push(`${post.label}: add a publication date and time to the Show Notes.`); continue; }
  }
  return issues;
}
