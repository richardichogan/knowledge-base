import { object, text } from '../jobs/contracts.js';
import { ValidationError } from '../types/errors.js';

export type FeedId = 'bluesky' | 'blog-linkedin';
export type Destination = 'bluesky' | 'blog' | 'linkedin';
export interface FeedPolicy {
  timezone: string; startHour: number; endHour: number; days: number[]; expiryHours: number; guidance: string;
}
export interface PublishingFeed { id: FeedId; enabled: boolean; revision: number; policy: FeedPolicy }
export interface Topic {
  id: string; title: string; fingerprint: string; rationale: string; priority: number; eventKey: string;
  state: 'pending' | 'assessing' | 'ready' | 'held' | 'rejected'; error: string | null;
  createdAt: string; assessedAt: string | null;
}
export interface Source { itemId: string; topicId: string; title: string; url: string; body: string; readAt: string | null; discoveredAt: string }
export interface Draft {
  id: string; topicId: string; destination: Destination; variant: 'source' | 'blog'; version: number;
  content: Record<string, unknown>; review: 'pending' | 'pass' | 'revise' | 'hold'; approval: 'pending' | 'approved' | 'rejected';
  held: boolean; reason: string; distinctArgument: boolean; reviewedAt: string | null; expiresAt: string;
  reviewedBlogVersion: number | null;
  reviewedFeedRevision: number | null;
}
export interface Delivery {
  id: string; identity: string; destination: Destination; topicId: string | null; draftId: string | null; version: number | null;
  account: string; status: 'sending' | 'sent' | 'failed' | 'unconfirmed'; attemptedAt: string; publishedAt: string | null;
  nextAttemptAt: string | null; attempts: number; receipt: Record<string, unknown> | null; error: string | null;
}
const RETRY_INITIAL = 5;
const RETRY_SECOND = 15;
const RETRY_FINAL = 60;
export const PUBLISH_LIMITS = {
  // Instructions, guidance and the largest saved draft (maxText) sent alongside sources.
  intake: 10, promptTokens: 40_000, minimumSource: 800, recentTopics: 60, draftsPerTick: 1,
  selectionTokens: 1400, draftTokens: 5000, reviewTokens: 1800, revisions: 2,
  staleHours: 24, sameTopicHours: 24, blueskyCap: 4, linkedinCap: 3,
  blueskySpacingHours: 2, linkedinSpacingHours: 3, maxHistory: 50, maxGuidance: 4000,
  dayHours: 24, maxExpiry: 720, maxHour: 23, weekDays: 7, maxPriority: 100,
  maxText: 100_000, maxCopy: 2700, maxBlueCopy: 240, retryMinutes: [RETRY_INITIAL, RETRY_SECOND, RETRY_FINAL], leaseMinutes: 15,
  verificationChars: 120, serverError: 500,
  refreshAssessments: 12,
  packageDestinations: 2, half: 2, historyOffset: 10_000,
  sourcesPerTopic: 4,
  alternatives: 3, exceptionPriority: 90,
  draftShortlist: 8,
} as const;
export function feedId(value: unknown): FeedId {
  if (value !== 'bluesky' && value !== 'blog-linkedin') throw new ValidationError('Choose Bluesky or Blog/LinkedIn.');
  return value;
}
export function uuid(value: unknown): string {
  const id = text(value, 'ID');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new ValidationError('Invalid publishing ID.');
  return id;
}
export function parsePolicy(value: unknown): FeedPolicy {
  const p = object(value);
  const integer = (v: unknown, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ValidationError('Invalid publishing schedule or expiry.');
    return v;
  };
  const timezone = text(p.timezone, 'timezone');
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(); }
  catch { throw new ValidationError('Use a valid IANA timezone.'); }
  if (!Array.isArray(p.days) || !p.days.length || p.days.length > PUBLISH_LIMITS.weekDays) throw new ValidationError('Choose publishing days.');
  const startHour = integer(p.startHour, 0, PUBLISH_LIMITS.maxHour);
  const endHour = integer(p.endHour, 1, PUBLISH_LIMITS.dayHours);
  if (endHour <= startHour) throw new ValidationError('Publishing window must finish after it starts.');
  return { timezone, startHour, endHour, days: [...new Set(p.days.map(day => integer(day, 0, PUBLISH_LIMITS.weekDays - 1)))],
    expiryHours: integer(p.expiryHours, 1, PUBLISH_LIMITS.maxExpiry), guidance: text(p.guidance ?? '', 'editorial guidance', PUBLISH_LIMITS.maxGuidance) };
}
