import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { env } from '../config/env.js';
import { ValidationError } from '../types/errors.js';
import { object, text } from '../jobs/contracts.js';
import { proposeJob } from '../jobs/store.js';
import { feedId, parsePolicy, uuid, PUBLISH_LIMITS } from '../publishing/contracts.js';
import { feeds, holdTopic, listTopics, rejectDraftTopic, releaseTopic, requestRegeneration, topicDetail } from '../publishing/store.js';
import { listPublishingContent } from '../publishing/content.js';
import { getPublishingPicks, holdColdDrafts, refreshPublishingPicks } from '../publishing/picks.js';
import { refreshSchedule } from '../publishing/schedule.js';

const CONTENT_PAGE_SIZE = 5;
const CONTENT_PAGE_CHARS = 128_000;

export const PUBLISHING_TOOL: LlmToolDefinition = {
  type: 'function', function: {
    name: 'manage_publishing_feeds',
    description: 'Inspect and configure Athena Discover publishing from any chat. Two feeds: bluesky and blog-linkedin. Work with the user on editorial guidance and saved settings. Read first; save produces an exact confirmation card, never silently enables posting. Can hold/reject topics with reasons. Use retry on a held topic whose preparation stopped (read shows the reason in topic.error); it releases the package for re-preparation and never approves anything. Use regenerate on a package whose Blog, LinkedIn or Bluesky draft is stuck in Needs review or Held after failed checks (the draft reason says why): it rewrites each failed draft from its sources and reviews it again, and never approves anything. To reject and remove an entire unapproved draft, use reject_draft only on explicit request after reading the topic and providing every current draft version. Approved, scheduled or attempted posts are protected; the source is retained. One human package approval in the publishing UI approves the exact Blog and LinkedIn versions together; you CANNOT grant approval, reconcile deliveries or send a post. Drafts do not expire automatically. Queues, source evidence, accuracy/voice findings and audit are shared with the UI. There are no daily posting limits; audio/podcast preparation is independent. Today\'s picks: picks returns the three unapproved drafts Athena chose as most worth approving today (chosen each morning at 08:30 UK), each with a one-line reason, plus how many Discover drafts have waited over 7 days; repick chooses again now. Picking never approves anything. hold_cold holds every Discover draft pending over 7 days except today\'s picks; held drafts stay recoverable in Drafts. Use hold_cold only when the user explicitly asks in this chat.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'content', 'read', 'save', 'hold', 'reject', 'reject_draft', 'retry', 'regenerate', 'picks', 'repick', 'hold_cold'] },
      offset: { type: 'integer', description: 'For content: zero-based offset in the combined saved publishing list. Returns full paged entries, including source, copy, campaign and job identifiers.' },
      id: { type: 'string', description: 'Feed ID bluesky|blog-linkedin for save; topic UUID for read/hold/reject/retry.' },
      revision: { type: 'integer' }, enabled: { type: 'boolean' },
      policy: { type: 'object', description: 'Complete existing policy with requested edits: timezone, startHour, endHour, days:[0 Sunday..6], guidance. Retain unspecified legacy fields; expiryHours is ignored for scheduling and delivery.', additionalProperties: true },
      reason: { type: 'string' },
      versions: { type: 'object', description: 'For reject_draft: every saved draft ID mapped to its current version from read.', additionalProperties: { type: 'integer' } },
    }, required: ['action'] },
  },
};
export async function executePublishingTool(db: Pool, args: Record<string, unknown>, sessionId?: string): Promise<unknown> {
  if (args.action === 'content') {
    const offset = args.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new ValidationError('Use a nonnegative publishing content offset.');
    const all = await listPublishingContent(db);
    const entries = [];
    let size = 0;
    for (const entry of all.slice(offset, offset + CONTENT_PAGE_SIZE)) {
      const length = JSON.stringify(entry).length;
      if (size + length > CONTENT_PAGE_CHARS) break;
      entries.push(entry); size += length;
    }
    if (!entries.length && offset < all.length) throw new ValidationError('This entry exceeds the paged content limit. Retrieve the identified campaign or managed job through its existing read tool.');
    return { entries, total: all.length, nextOffset: offset + entries.length < all.length ? offset + entries.length : null,
      access: 'These are actual saved entries. Read Discover topics for full editorial copy/evidence, podcast campaigns for current review and artwork, and managed jobs for complete source bodies, approvals and delivery receipts. Displaying a draft never authorises publication.' };
  }
  if (args.action === 'list') return {
    feeds: await feeds(db), topics: await listTopics(db, 0, true), reviewUrl: '/discover?publishing=1',
    selectionPolicy: `Finished, reviewed drafts only. Microsoft-first, newest relevant evidence first. At most ${PUBLISH_LIMITS.draftShortlist} draft entries total; blog/social packages count as one entry. Scheduled or published topics do not appear in Drafts. Every content sync refreshes and reviews the shortlist without changing scheduled copy. Scheduled entries are separate from the draft limit. Non-Microsoft stories need an exceptional, explicit audience-relevance rationale. Human approval sends each exact version for scheduling, never immediate publication.`,
  };
  if (args.action === 'read') return topicDetail(db, uuid(args.id));
  if (args.action === 'picks') return (await getPublishingPicks(db)) ?? { picks: [], note: 'No picks have been chosen yet; use repick.' };
  if (args.action === 'repick') { await refreshPublishingPicks(db, 'athena'); return getPublishingPicks(db); }
  if (env.NODE_ENV !== 'production' && !env.isDevelopment) throw new ValidationError('Publishing changes require an application server.');
  if (args.action === 'save') {
    if (!sessionId) throw new ValidationError('Save this chat before proposing feed settings.');
    const id = feedId(args.id);
    const current = (await feeds(db)).find(f => f.id === id)!;
    if (args.revision !== current.revision || typeof args.enabled !== 'boolean') throw new ValidationError('Read the current feed revision and provide an explicit automation setting.');
    return proposeJob(db, sessionId, { operation: 'feed-settings', id, revision: current.revision, enabled: args.enabled, policy: parsePolicy(args.policy) });
  }
  if (args.action === 'hold_cold') {
    const result = await holdColdDrafts(db, `chat:${sessionId ?? 'unsaved'}`);
    await refreshSchedule(db);
    return { ...result, recoverable: 'Held drafts remain in Publishing > Drafts and can be resumed.' };
  }
  if (args.action === 'reject_draft') {
    await rejectDraftTopic(db, uuid(args.id), object(args.versions), `chat:${sessionId ?? 'unsaved'}`);
    return { rejected: true, sourceRetained: true };
  }
  if (args.action === 'retry') {
    if (!await releaseTopic(db, uuid(args.id), `chat:${sessionId ?? 'unsaved'}`)) throw new ValidationError('Only a held topic with unapproved drafts and no scheduled or delivered posts can be retried.');
    return { retried: true };
  }
  if (args.action === 'regenerate') {
    if (!await requestRegeneration(db, uuid(args.id), `chat:${sessionId ?? 'unsaved'}`)) throw new ValidationError('Only a package with unapproved, unscheduled drafts that have not passed review can be rewritten.');
    return { regenerating: true, note: 'The review worker rewrites each failed draft from its sources and reviews it again; it never approves anything.' };
  }
  if (args.action === 'hold' || args.action === 'reject') {
    await holdTopic(db, uuid(args.id), args.action === 'reject', `chat:${sessionId ?? 'unsaved'}`, text(args.reason, 'editorial reason', PUBLISH_LIMITS.maxGuidance));
    return { saved: true };
  }
  throw new ValidationError('Unknown publishing action.');
}
