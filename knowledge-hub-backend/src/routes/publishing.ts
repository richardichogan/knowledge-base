import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { getDb as defaultGetDb } from '../db/db.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { object, text } from '../jobs/contracts.js';
import { ValidationError, ConflictError, NotFoundError } from '../types/errors.js';
import { getLinkedInMember } from '../integrations/social/linkedin.js';
import { approvePackage, decideDraft, deliveryColumns, draftColumns, event, feeds, holdTopic, listTopics, saveFeed, topicDetail, transaction } from '../publishing/store.js';
import { feedId, PUBLISH_LIMITS, uuid, type Delivery, type Draft } from '../publishing/contracts.js';
import { editDraft } from '../publishing/editorial.js';
import { verifyBlog } from '../publishing/worker.js';
import { destinationAccount } from '../publishing/delivery.js';
import { MS_PER_MINUTE } from '../config/constants.js';
import { listSchedule, refreshSchedule } from '../publishing/schedule.js';

export function publishingProduction(): void {
  if (env.NODE_ENV !== 'production' && !env.isDevelopment) throw new ValidationError('Publishing changes require an application server or an isolated production-mode test.');
}
export async function reconcilePublishing(db: Pool, id: string, body: Record<string, unknown>, actor: string): Promise<void> {
  const delivery = (await db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries WHERE id=$1`, [id])).rows[0];
  if (!delivery) throw new NotFoundError('Publishing delivery');
  if (!['unconfirmed', 'sending', 'failed'].includes(delivery.status)) throw new ValidationError('This delivery does not need reconciliation.');
  if (delivery.status === 'sending' && Date.now() - new Date(delivery.attemptedAt).getTime() < PUBLISH_LIMITS.leaseMinutes * MS_PER_MINUTE) throw new ConflictError('Delivery may still be in flight. Wait before reconciling it.', 'PUBLISHING_IN_FLIGHT');
  if (typeof body.delivered !== 'boolean') throw new ValidationError('Confirm whether the delivery actually occurred.');
  let receipt: Record<string, unknown> | null = null;
  let at: string | null = null;
  if (body.delivered) {
    let url: URL;
    try { url = new URL(text(body.url, 'public URL')); } catch { throw new ValidationError('Provide the confirmed public HTTPS post URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new ValidationError('Provide the confirmed public HTTPS post URL.');
    at = text(body.publishedAt, 'actual publication time');
    if (!Number.isFinite(Date.parse(at)) || new Date(at) > new Date()) throw new ValidationError('Provide the actual publication time, not a future time.');
    receipt = { url: url.href, manuallyConfirmed: true };
    if (delivery.destination === 'blog') {
      const draft = (await db.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE id=$1 AND version=$2`, [delivery.draftId, delivery.version])).rows[0];
      if (!draft) throw new ValidationError('The exact published blog draft is unavailable.');
      receipt = { ...receipt, ...await verifyBlog(url.href, draft.content) };
    } else if (url.hostname !== (delivery.destination === 'bluesky' ? 'bsky.app' : 'www.linkedin.com')) throw new ValidationError('The receipt must be a public post on the selected social network.');
  }
  await transaction(db, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`athena-publish:${delivery.destination}:${delivery.account}`]);
    const changed = await c.query(`UPDATE publishing_deliveries SET status=$2,receipt=$3,published_at=$4,next_attempt_at=$5,error=NULL
      WHERE id=$1 AND status=$6 AND attempted_at=$7 RETURNING id`, [id, body.delivered ? 'sent' : 'failed', receipt ? JSON.stringify(receipt) : null,
      at, body.delivered ? null : new Date().toISOString(), delivery.status, delivery.attemptedAt]);
    if (!changed.rowCount) throw new ConflictError('Delivery changed; reload.', 'PUBLISHING_CONFLICT');
    if (!body.delivered && delivery.draftId) await c.query('UPDATE publishing_drafts SET held=FALSE WHERE id=$1 AND version=$2', [delivery.draftId, delivery.version]);
    if (delivery.identity.startsWith('discover:')) {
      const itemId = uuid(delivery.identity.slice('discover:'.length));
      const key = delivery.destination === 'bluesky' ? 'blueskyPost' : 'linkedinPost';
      if (body.delivered) await c.query(`UPDATE content_items SET workflow_state='published',
        metadata=COALESCE(metadata,'{}') || jsonb_build_object($2::text,$3::jsonb) WHERE id=$1`,
      [itemId, key, JSON.stringify({ status: 'posted', url: receipt?.url, postedAt: at, ledgerManaged: true })]);
      else await c.query('UPDATE content_items SET metadata=metadata-$2::text WHERE id=$1', [itemId, key]);
    }
    if (delivery.identity.startsWith('jobs:')) {
      const [, runId, key] = delivery.identity.split(':');
      await c.query(`UPDATE managed_job_runs SET steps=(SELECT jsonb_agg(CASE WHEN s->>'key'=$2
        THEN s || jsonb_build_object('status',$3::text,'result',$4::jsonb,'finishedAt',$5::text) ELSE s END)
        FROM jsonb_array_elements(steps) s),status='partial',updated_at=NOW()
        WHERE id=$1 AND (lease_until IS NULL OR lease_until<NOW())`,
      [uuid(runId), key, body.delivered ? 'succeeded' : 'failed', JSON.stringify(receipt), at ?? new Date().toISOString()]);
    }
    await event(c, delivery.topicId, actor, 'delivery-reconciled', { id, delivered: body.delivered, receipt, publishedAt: at, reason: text(body.reason ?? '', 'reason', PUBLISH_LIMITS.maxGuidance) });
  });
}
export function createPublishingRouter(getDb: () => Pool = defaultGetDb): Router {
  const router = Router();
  const actor = (req: Parameters<RequestHandler>[0]): string => (req as AuthenticatedRequest).userId;
  const route = (action: (req: Parameters<RequestHandler>[0]) => unknown): RequestHandler => (req, res, next) => {
    void Promise.resolve().then(() => action(req)).then(data => res.json({ success: true, data })).catch(next);
  };
  router.get('/feeds', route(() => feeds(getDb())));
  router.get('/schedule', route(() => listSchedule(getDb())));
  router.post('/schedule/refresh', route(async () => {
    publishingProduction(); await refreshSchedule(getDb()); return listSchedule(getDb());
  }));
  router.put('/feeds/:id', route(async req => {
    publishingProduction(); const b = object(req.body);
    const saved = await saveFeed(getDb(), feedId(req.params.id), b.revision, b.enabled, b.policy, actor(req));
    await refreshSchedule(getDb()); return saved;
  }));
  router.get('/topics', route(req => {
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > PUBLISH_LIMITS.historyOffset) throw new ValidationError('Invalid queue offset.');
    return listTopics(getDb(), offset, true);
  }));
  router.get('/topics/:id', route(req => topicDetail(getDb(), uuid(req.params.id))));
  router.post('/topics/:id/approve', route(async req => {
    publishingProduction(); const b = object(req.body); const versions = object(b.versions);
    await approvePackage(getDb(), uuid(req.params.id), { blog: versions.blog, linkedin: versions.linkedin }, actor(req));
    await refreshSchedule(getDb());
    return { saved: true };
  }));
  router.post('/topics/:id/decision', route(async req => {
    publishingProduction(); const b = object(req.body); const id = uuid(req.params.id);
    if (b.action === 'reassess') {
      const changed = await getDb().query(`UPDATE publishing_topics SET state='pending',error=NULL
        WHERE id=$1 AND state IN ('held','rejected') AND NOT EXISTS(SELECT 1 FROM publishing_drafts WHERE topic_id=$1) RETURNING id`, [id]);
      if (!changed.rowCount) throw new ValidationError('Only held topics without drafts can be reassessed; edit existing drafts instead.');
      await event(getDb(), id, actor(req), 'reassessment-requested', {});
    } else {
      if (!['hold', 'reject'].includes(String(b.action))) throw new ValidationError('Choose hold, reject or reassess.');
      await holdTopic(getDb(), id, b.action === 'reject', actor(req), text(b.reason ?? '', 'reason', PUBLISH_LIMITS.maxGuidance));
    }
    await refreshSchedule(getDb());
    return topicDetail(getDb(), id);
  }));
  router.put('/drafts/:id', route(async req => {
    publishingProduction(); const b = object(req.body); await editDraft(getDb(), uuid(req.params.id), b.version, b.content, actor(req));
    await refreshSchedule(getDb()); return { saved: true };
  }));
  router.post('/drafts/:id/decision', route(async req => {
    publishingProduction(); const b = object(req.body); const id = uuid(req.params.id);
    if (!['approve', 'reject', 'hold', 'resume'].includes(String(b.action))) throw new ValidationError('Unknown draft decision.');
    const action = b.action as 'approve' | 'reject' | 'hold' | 'resume';
    await decideDraft(getDb(), id, b.version, action, actor(req), text(b.reason ?? '', 'reason', PUBLISH_LIMITS.maxGuidance));
    if (action === 'resume') {
      await getDb().query("UPDATE publishing_topics SET state='ready',error=NULL WHERE id=(SELECT topic_id FROM publishing_drafts WHERE id=$1) AND state='held'", [id]);
    }
    await refreshSchedule(getDb());
    return { saved: true };
  }));
  router.post('/drafts/:id/review', route(async req => {
    publishingProduction(); const b = object(req.body);
    await transaction(getDb(), async c => {
      const draft = (await c.query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE id=$1 FOR UPDATE`, [uuid(req.params.id)])).rows[0];
      if (!draft || draft.version !== b.version) throw new ConflictError('Draft changed; reload.', 'PUBLISHING_CONFLICT');
      const delivered = await c.query("SELECT id FROM publishing_deliveries WHERE draft_id=$1 AND status IN ('sent','sending','unconfirmed')", [draft.id]);
      if (delivered.rowCount) throw new ValidationError('This draft has a delivered or unresolved publication. Reconcile it before requesting another review.');
      await c.query(`UPDATE publishing_drafts SET review='pending',approval='pending',held=FALSE,reviewed_at=NULL,
        reason='Review requested.',updated_at=NOW() WHERE id=$1`, [draft.id]);
      await c.query("UPDATE publishing_topics SET state='ready',error=NULL WHERE id=$1 AND state IN ('held','rejected')", [draft.topicId]);
      await event(c, draft.topicId, actor(req), 'review-requested', { id: draft.id, version: b.version });
    });
    await refreshSchedule(getDb()); return { queued: true };
  }));
  router.post('/drafts/:id/account', route(async req => {
    publishingProduction();
    const id = uuid(req.params.id); const b = object(req.body);
    const draft = (await getDb().query<Draft>(`SELECT ${draftColumns} FROM publishing_drafts WHERE id=$1`, [id])).rows[0];
    if (!draft) throw new NotFoundError('Draft');
    const member = draft.destination === 'linkedin' ? await getLinkedInMember() : null;
    const account = member?.id ?? destinationAccount(draft.destination);
    await editDraft(getDb(), id, b.version, draft.content, actor(req), { id: account, ...(member ? { name: member.name } : {}) });
    await refreshSchedule(getDb());
    return { saved: true };
  }));
  router.get('/history', route(async req => {
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > PUBLISH_LIMITS.historyOffset) throw new ValidationError('Invalid history offset.');
    return (await getDb().query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries ORDER BY attempted_at DESC LIMIT $1 OFFSET $2`, [PUBLISH_LIMITS.maxHistory, offset])).rows;
  }));
  router.get('/audit', route(async req => {
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > PUBLISH_LIMITS.historyOffset) throw new ValidationError('Invalid audit offset.');
    return (await getDb().query<Record<string, unknown>>('SELECT id,topic_id AS "topicId",actor,event,detail,created_at AS "createdAt" FROM publishing_events ORDER BY id DESC LIMIT $1 OFFSET $2', [PUBLISH_LIMITS.maxHistory, offset])).rows;
  }));
  router.post('/deliveries/:id/reconcile', route(async req => {
    publishingProduction(); await reconcilePublishing(getDb(), uuid(req.params.id), object(req.body), actor(req));
    await refreshSchedule(getDb()); return { saved: true };
  }));
  return router;
}
export const publishingRouter = createPublishingRouter();
