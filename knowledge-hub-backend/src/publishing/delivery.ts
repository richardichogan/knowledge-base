import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../config/constants.js';
import { ConflictError, IntegrationError, ValidationError } from '../types/errors.js';
import { localClock } from '../jobs/schedule.js';
import { deliveryColumns, draftColumns, event, transaction } from './store.js';
import { PUBLISH_LIMITS, type Delivery, type Destination, type PublishingFeed, type FeedId, type FeedPolicy, type Draft } from './contracts.js';
import { importPublishingHistory } from './legacyHistory.js';

export class PublicationDeferred extends ConflictError {
  constructor(reason: string) { super(reason, 'PUBLICATION_DEFERRED'); }
}
export class PublicationUnconfirmed extends IntegrationError {
  constructor(reason: string) { super('publishing', reason); }
}
export interface DeliveryContext {
  identity: string; topicId?: string; draftId?: string; version?: number; feed?: FeedId;
  distinctArgument?: boolean; now?: Date;
}
export function inWindow(policy: FeedPolicy, now: Date): boolean {
  const local = localClock(now, policy.timezone);
  const weekday = new Date(`${local.day}T12:00:00Z`).getUTCDay();
  const hour = Number(local.time.split(':')[0]);
  return policy.days.includes(weekday) && hour >= policy.startHour && hour < policy.endHour;
}
export function destinationAccount(destination: Destination, member?: string): string {
  if (destination === 'bluesky') return env.BLUESKY_IDENTIFIER ?? '(not connected)';
  if (destination === 'linkedin') return member ?? '(not connected)';
  return new URL(env.BLOG_POSTS_URL).host;
}
export function slotBlock(history: Delivery[], destination: Destination, now: Date): string | null {
  if (history.some(d => d.status === 'sending' || d.status === 'unconfirmed')) return 'An earlier delivery is unresolved. Reconcile it before sending again.';
  if (destination === 'blog') return null;
  const day = localClock(now, 'Europe/London').day;
  const sent = history.filter(d => d.status === 'sent' && d.publishedAt);
  const cap = destination === 'bluesky' ? PUBLISH_LIMITS.blueskyCap : PUBLISH_LIMITS.linkedinCap;
  if (sent.filter(d => localClock(new Date(d.publishedAt!), 'Europe/London').day === day).length >= cap) return 'Daily publishing limit reached.';
  const spacing = destination === 'bluesky' ? PUBLISH_LIMITS.blueskySpacingHours : PUBLISH_LIMITS.linkedinSpacingHours;
  if (sent.some(d => now.getTime() - new Date(d.publishedAt!).getTime() < spacing * MS_PER_HOUR)) return 'Waiting for the minimum interval since the last successful post.';
  return null;
}
export async function assertSocialOpportunity(db: Pool, destination: 'linkedin' | 'bluesky', account: string, now = new Date()): Promise<void> {
  await importPublishingHistory(db, destination, account);
  const history = (await db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries WHERE destination=$1 AND account=$2
    AND (attempted_at>$3::timestamptz-INTERVAL '2 days' OR published_at>$3::timestamptz-INTERVAL '2 days' OR status IN ('sending','unconfirmed'))`, [destination, account, now.toISOString()])).rows;
  const blocked = slotBlock(history, destination, now);
  if (blocked) throw new PublicationDeferred(blocked);
}
export async function reserveDelivery(db: Pool, destination: Destination, account: string, context: DeliveryContext): Promise<Delivery> {
  const now = context.now ?? new Date();
  if (destination !== 'blog') await importPublishingHistory(db, destination, account);
  return transaction(db, async c => {
    // Feed locks serialize pause/configuration with new claims. No network work holds them.
    const settings = (await c.query<PublishingFeed>('SELECT id,enabled,revision,policy FROM publishing_feeds ORDER BY id FOR UPDATE')).rows;
    if (context.feed) {
      const feed = settings.find(f => f.id === context.feed);
      if (!feed?.enabled) throw new PublicationDeferred('Posting automation is off for this feed.');
      if (!inWindow(feed.policy, now)) throw new PublicationDeferred('Outside the configured publishing window.');
    }
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`athena-publish:${destination}:${account}`]);
    const existing = (await c.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries WHERE identity=$1 AND destination=$2 FOR UPDATE`, [context.identity, destination])).rows[0];
    if (existing?.account && existing.account !== account) throw new PublicationDeferred('Publishing account changed. Re-review the destination before continuing.');
    if (existing?.status === 'sent') return existing;
    if (context.topicId) {
      const topic = await c.query<{ state: string }>('SELECT state FROM publishing_topics WHERE id=$1 FOR NO KEY UPDATE', [context.topicId]);
      if (!topic.rows[0] || topic.rows[0].state !== 'ready') throw new PublicationDeferred('Topic is held, rejected or not ready.');
    }
    if (context.draftId) {
      const withdrawn = await c.query(`SELECT s.item_id FROM publishing_sources s JOIN content_items c ON c.id=s.item_id
        WHERE s.topic_id=$1 AND c.workflow_state IN ('archived','shelved') LIMIT 1`, [context.topicId]);
      if (withdrawn.rowCount) throw new PublicationDeferred('Source material was archived or shelved after selection.');
      const topicDrafts = (await c.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE topic_id=$1 ORDER BY id FOR UPDATE`, [context.topicId])).rows;
      const draft = topicDrafts.find(d => d.id === context.draftId);
      if (!draft || draft.destination !== destination || draft.version !== context.version || draft.content.account !== account) throw new PublicationDeferred('Draft, version or destination account changed. Review the current version.');
      const required = draft.variant === 'blog' ? topicDrafts.filter(d => d.destination === 'blog' || d.destination === 'linkedin') : [];
      if (draft.variant === 'blog' && required.length !== PUBLISH_LIMITS.packageDestinations) throw new PublicationDeferred('Blog and LinkedIn drafts are both required.');
      for (const candidate of [draft, ...required]) {
        if (candidate.held || candidate.approval === 'rejected' || candidate.review !== 'pass' || !candidate.reviewedAt
          || now.getTime() - new Date(candidate.reviewedAt).getTime() > PUBLISH_LIMITS.staleHours * MS_PER_HOUR) throw new PublicationDeferred('Draft is held or awaiting a fresh editorial review.');
        if (candidate.reviewedFeedRevision !== settings.find(f => f.id === (candidate.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin'))?.revision) throw new PublicationDeferred('Feed settings changed since editorial review.');
        if (candidate.variant === 'blog' && candidate.destination !== 'bluesky' && candidate.approval !== 'approved') throw new PublicationDeferred('Both the blog and LinkedIn hook require human approval.');
        if (candidate.destination === 'bluesky' && candidate.approval !== 'approved') throw new PublicationDeferred('The exact Bluesky draft requires human approval before scheduling.');
        if (candidate.variant === 'blog' && candidate.destination !== 'blog'
          && candidate.reviewedBlogVersion !== required.find(d => d.destination === 'blog')?.version) throw new PublicationDeferred('Hook consistency must be checked against the current blog version.');
      }
      if (draft.variant === 'source' && topicDrafts.some(d => d.destination === 'blog')) throw new PublicationDeferred('Source promotion is superseded by the blog package.');
      if (draft.variant === 'blog' && destination !== 'blog') {
        const published = await c.query<{ receipt: Record<string, unknown> }>("SELECT receipt FROM publishing_deliveries WHERE topic_id=$1 AND destination='blog' AND status='sent'", [context.topicId]);
        if (!published.rows[0]?.receipt.verifiedAt) throw new PublicationDeferred('The public blog has not been verified.');
      }
    }
    if (existing?.status === 'failed' && (!existing.nextAttemptAt || new Date(existing.nextAttemptAt) > now)) throw new PublicationDeferred(existing.error ?? 'Delivery is held.');
    const history = (await c.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries
      WHERE destination=$1 AND account=$2 AND (attempted_at>$3::timestamptz-INTERVAL '2 days' OR published_at>$3::timestamptz-INTERVAL '2 days' OR status IN ('sending','unconfirmed'))`,
    [destination, account, now.toISOString()])).rows;
    const blocked = slotBlock(history, destination, now);
    if (blocked) throw new PublicationDeferred(blocked);
    if (context.topicId) {
      if (destination === 'bluesky') {
        const prior = (await c.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries WHERE destination='bluesky'
          AND account=$2 AND status='sent' AND topic_id IN(SELECT id FROM publishing_topics WHERE
          event_key=(SELECT event_key FROM publishing_topics WHERE id=$1))`, [context.topicId, account])).rows;
        if (prior.length && (!context.distinctArgument || prior.some(d => now.getTime() - new Date(d.publishedAt!).getTime() < PUBLISH_LIMITS.sameTopicHours * MS_PER_HOUR))) {
          throw new PublicationDeferred('Same-topic promotion needs a distinct argument and at least 24 hours.');
        }
      }
    }
    if (context.draftId) {
      const scheduled = await c.query(`SELECT draft_id FROM publishing_schedule
        WHERE draft_id=$1 AND version=$2 AND scheduled_at<=$3::timestamptz FOR SHARE`, [context.draftId, context.version, now.toISOString()]);
      if (!scheduled.rowCount) throw new PublicationDeferred('Waiting for the assigned publishing slot.');
    }
    const result = await c.query<Delivery>(`INSERT INTO publishing_deliveries(identity,destination,topic_id,draft_id,version,account,status,attempted_at)
      VALUES($1,$2,COALESCE($3::uuid,(SELECT topic_id FROM publishing_sources WHERE 'discover:' || item_id=$1 LIMIT 1)),$4,$5,$6,'sending',$7)
      ON CONFLICT(identity,destination) DO UPDATE SET status='sending',attempted_at=$7,attempts=publishing_deliveries.attempts+1,error=NULL
      RETURNING ${deliveryColumns}`, [context.identity, destination, context.topicId ?? null, context.draftId ?? null, context.version ?? null, account, now.toISOString()]);
    await event(c, context.topicId ?? null, 'publisher', 'delivery-started', { destination, identity: context.identity, account });
    return result.rows[0]!;
  });
}
export async function deliver<T extends object>(db: Pool, destination: Destination, account: string, context: DeliveryContext, send: () => Promise<T>): Promise<T> {
  const claim = await reserveDelivery(db, destination, account, context);
  if (claim.status === 'sent') return claim.receipt as T;
  let result: T;
  try { result = await send(); }
  catch (error) {
    const uncertain = error instanceof PublicationUnconfirmed || !(error instanceof ValidationError || error instanceof IntegrationError)
      || ['BlueskyPostUnconfirmedError', 'LinkedInPostUnconfirmedError'].includes(error.name);
    const message = error instanceof Error ? error.message : 'Delivery failed';
    const delay = PUBLISH_LIMITS.retryMinutes[claim.attempts - 1];
    const transient = error instanceof IntegrationError && /\b429\b/.test(message);
    const next = !uncertain && transient && delay !== undefined ? new Date(Date.now() + delay * MS_PER_MINUTE).toISOString() : null;
    await db.query(`UPDATE publishing_deliveries SET status=$2,error=$3,next_attempt_at=$4 WHERE id=$1 AND status='sending'`,
      [claim.id, uncertain ? 'unconfirmed' : 'failed', message, next]);
    await event(db, context.topicId ?? null, 'publisher', uncertain ? 'delivery-unconfirmed' : 'delivery-failed', { id: claim.id, error: message });
    if (uncertain && !(error instanceof PublicationUnconfirmed)) throw new PublicationUnconfirmed(message);
    throw error;
  }
  // If persisting the receipt fails, retain "sending": it blocks a duplicate.
  try {
    await transaction(db, async c => {
      await c.query(`UPDATE publishing_deliveries SET status='sent',receipt=$2,published_at=NOW(),error=NULL,next_attempt_at=NULL WHERE id=$1 AND status='sending'`, [claim.id, JSON.stringify(result)]);
      await event(c, context.topicId ?? null, 'publisher', 'delivery-sent', { destination, receipt: result });
    });
  } catch (error) {
    console.error('[Publishing] Delivery receipt could not be committed:', error);
    throw new PublicationUnconfirmed('Delivery may be live, but its receipt could not be saved. Reconcile it before retrying.');
  }
  return result;
}
