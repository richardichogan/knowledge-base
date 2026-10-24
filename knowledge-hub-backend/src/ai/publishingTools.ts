import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { env } from '../config/env.js';
import { ValidationError } from '../types/errors.js';
import { text } from '../jobs/contracts.js';
import { proposeJob } from '../jobs/store.js';
import { feedId, parsePolicy, uuid, PUBLISH_LIMITS } from '../publishing/contracts.js';
import { feeds, holdTopic, listTopics, topicDetail } from '../publishing/store.js';

export const PUBLISHING_TOOL: LlmToolDefinition = {
  type: 'function', function: {
    name: 'manage_publishing_feeds',
    description: 'Inspect and configure Athena Discover publishing from any chat. Two feeds: bluesky and blog-linkedin. Work with the user on editorial guidance and saved settings. Read first; save produces an exact confirmation card, never silently enables posting. Can hold/reject topics with reasons. One human package approval in the publishing UI approves the exact Blog and LinkedIn versions together; you CANNOT grant approval, reconcile deliveries or send a post. Drafts do not expire automatically. Queues, source evidence, accuracy/voice findings and audit are shared with the UI. Daily caps are ceilings, not targets; audio/podcast preparation is independent.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'read', 'save', 'hold', 'reject'] },
      id: { type: 'string', description: 'Feed ID bluesky|blog-linkedin for save; topic UUID for read/hold/reject.' },
      revision: { type: 'integer' }, enabled: { type: 'boolean' },
      policy: { type: 'object', description: 'Complete existing policy with requested edits: timezone, startHour, endHour, days:[0 Sunday..6], guidance. Retain unspecified legacy fields; expiryHours is ignored for scheduling and delivery.', additionalProperties: true },
      reason: { type: 'string' },
    }, required: ['action'] },
  },
};
export async function executePublishingTool(db: Pool, args: Record<string, unknown>, sessionId?: string): Promise<unknown> {
  if (args.action === 'list') return {
    feeds: await feeds(db), topics: await listTopics(db, 0, true), reviewUrl: '/discover?publishing=1',
    selectionPolicy: `Finished, reviewed drafts only. Microsoft-first, newest relevant evidence first. At most ${PUBLISH_LIMITS.draftShortlist} draft entries total; blog/social packages count as one entry. Scheduled or published topics do not appear in Drafts. Every content sync refreshes and reviews the shortlist without changing scheduled copy. Scheduled entries are separate from the draft limit. Non-Microsoft stories need an exceptional, explicit audience-relevance rationale. Human approval sends each exact version for scheduling, never immediate publication.`,
  };
  if (args.action === 'read') return topicDetail(db, uuid(args.id));
  if (env.NODE_ENV !== 'production' && !env.isDevelopment) throw new ValidationError('Publishing changes require an application server.');
  if (args.action === 'save') {
    if (!sessionId) throw new ValidationError('Save this chat before proposing feed settings.');
    const id = feedId(args.id);
    const current = (await feeds(db)).find(f => f.id === id)!;
    if (args.revision !== current.revision || typeof args.enabled !== 'boolean') throw new ValidationError('Read the current feed revision and provide an explicit automation setting.');
    return proposeJob(db, sessionId, { operation: 'feed-settings', id, revision: current.revision, enabled: args.enabled, policy: parsePolicy(args.policy) });
  }
  if (args.action === 'hold' || args.action === 'reject') {
    await holdTopic(db, uuid(args.id), args.action === 'reject', `chat:${sessionId ?? 'unsaved'}`, text(args.reason, 'editorial reason', PUBLISH_LIMITS.maxGuidance));
    return { saved: true };
  }
  throw new ValidationError('Unknown publishing action.');
}
