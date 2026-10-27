import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import { postToBluesky } from '../integrations/social/bluesky.js';
import { getLinkedInMember, postToLinkedIn } from '../integrations/social/linkedin.js';
import { sendToBlog } from '../services/blogPublisher.js';
import { readPublicPage } from '../utils/articleReading.js';
import { deliver, destinationAccount, inWindow, PublicationDeferred, type DeliveryContext } from './delivery.js';
import { deliveryColumns, event, feeds, transaction } from './store.js';
import { PUBLISH_LIMITS, type Delivery } from './contracts.js';
import { inspectAcceptedBlog, publishBlogWithVerification, verifyBlogForPromotion, type PublishingServices } from './worker.js';
import { campaignColumns, campaignDeliveries, podcastDeliveryPost } from './podcastCampaignStore.js';
import { podcastIdentity, type PodcastCampaign, type PodcastPost } from './podcastCampaign.js';

const services: PublishingServices = { blog: sendToBlog, bluesky: postToBluesky, linkedin: postToLinkedIn, read: readPublicPage, member: getLinkedInMember };

async function authorizePost(c: PoolClient, snapshot: PodcastCampaign, post: PodcastPost): Promise<void> {
  const campaign = (await c.query<PodcastCampaign>(`SELECT ${campaignColumns} FROM podcast_campaigns WHERE note_id=$1 FOR UPDATE`, [snapshot.noteId])).rows[0];
  if (!campaign?.plan || campaign.state !== 'approved' || campaign.revision !== snapshot.revision || !campaign.approvedAt) {
    throw new PublicationDeferred('The campaign changed or was paused before delivery.');
  }
  const active = await c.query(`SELECT id FROM notes WHERE id=$1 AND status='active'
    AND note_list_metadata(content)->>'contentType'='podcast-show-notes' FOR SHARE`, [snapshot.noteId]);
  if (!active.rowCount) throw new PublicationDeferred('The Show Notes were archived or changed to another content type.');
  const approved = campaign.plan.posts.find(item => item.id === post.id);
  if (!approved?.scheduledAt || Date.parse(approved.scheduledAt) > Date.now()) throw new PublicationDeferred('Waiting for the approved publication time.');
  const history = await campaignDeliveries(c, snapshot.noteId);
  const ordered = [...campaign.plan.posts].sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
  const preceding = ordered.slice(0, ordered.findIndex(item => item.id === post.id));
  if (preceding.some(item => !history.some(delivery => delivery.identity === podcastIdentity(snapshot.noteId, item.id)
    && delivery.status === 'sent' && (item.destination !== 'blog' || Boolean(delivery.receipt?.verifiedAt))))) {
    throw new PublicationDeferred('Waiting for an earlier campaign post to be confirmed.');
  }
}

export async function publishPodcastPost(db: Pool, campaign: PodcastCampaign, post: PodcastPost, send = services): Promise<void> {
  if (!campaign.plan) throw new PublicationDeferred('The campaign has no approved plan.');
  const account = campaign.plan.accounts[post.destination];
  const actualAccount = post.destination === 'linkedin' ? (await send.member()).id : destinationAccount(post.destination);
  if (account !== actualAccount) throw new PublicationDeferred('The connected publishing account changed. No post was sent.');
  const settings = await feeds(db);
  const policy = settings.find(feed => feed.id === (post.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin'))?.policy;
  if (!policy || !inWindow(policy, new Date())) throw new PublicationDeferred('Waiting for the account publishing window.');
  const context: DeliveryContext = {
    identity: podcastIdentity(campaign.noteId, post.id), version: campaign.revision,
    authorize: client => authorizePost(client, campaign, post),
  };
  if (post.destination === 'blog') {
    if (!post.blog) throw new PublicationDeferred('The approved launch blog is missing.');
    await publishBlogWithVerification(db, account, context, { ...post.blog }, send, true);
    return;
  }
  const blog = campaign.plan.posts.find(item => item.destination === 'blog');
  const history = await campaignDeliveries(db, campaign.noteId);
  const receipt = history.find(delivery => delivery.identity === podcastIdentity(campaign.noteId, blog?.id ?? '') && delivery.status === 'sent')?.receipt;
  if (!campaign.plan.followUp) {
    if (!blog?.blog || typeof receipt?.url !== 'string' || !receipt.verifiedAt) throw new PublicationDeferred('Waiting for the launch blog to be publicly verified.');
    await verifyBlogForPromotion(receipt.url, { ...blog.blog }, send.read);
  }
  if (post.destination === 'linkedin') {
    await deliver(db, 'linkedin', account, context, () => send.linkedin(post.copy, null, account));
  } else {
    if (!post.url) throw new PublicationDeferred('The approved episode listening URL is missing.');
    await deliver(db, 'bluesky', account, context, () => send.bluesky(post.copy, {
      url: post.url!, title: campaign.plan!.title, description: '',
    }));
  }
}

async function recoverPodcastBlogs(db: Pool, send: PublishingServices): Promise<void> {
  const pending = (await db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries
    WHERE identity LIKE 'podcast:%' AND destination='blog' AND receipt->>'accepted'='true'
      AND ((status='unconfirmed' AND next_attempt_at<=NOW())
        OR (status='sending' AND attempted_at<NOW()-($1 * INTERVAL '1 minute')))
    ORDER BY attempted_at LIMIT 10`, [PUBLISH_LIMITS.leaseMinutes])).rows;
  for (const delivery of pending) {
    const post = await podcastDeliveryPost(db, delivery.identity);
    if (!post?.blog) { console.error('[Podcast] Accepted blog has no saved campaign post:', delivery.id); continue; }
    const checked = await inspectAcceptedBlog(delivery, { ...post.blog }, send.read);
    await transaction(db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`athena-publish:blog:${delivery.account}`]);
      const changed = await c.query(`UPDATE publishing_deliveries SET status=$2,receipt=$3,error=$4,next_attempt_at=$5,
        published_at=CASE WHEN $2='sent' THEN COALESCE(published_at,attempted_at) ELSE published_at END
        WHERE id=$1 AND status=$6 AND attempted_at=$7 AND next_attempt_at IS NOT DISTINCT FROM $8::timestamptz RETURNING id`,
      [delivery.id, checked.verified ? 'sent' : 'unconfirmed', JSON.stringify(checked.receipt), checked.error, checked.next,
        delivery.status, delivery.attemptedAt, delivery.nextAttemptAt]);
      if (changed.rowCount) await event(c, null, 'podcast-verifier', checked.verified ? 'podcast-blog-confirmed' : 'podcast-blog-verification-pending',
        { identity: delivery.identity, error: checked.error, nextAttemptAt: checked.next });
      if (changed.rowCount) await c.query(`UPDATE podcast_campaigns SET error=$2
        WHERE note_id=$1 AND error=$3`, [delivery.identity.split(':')[1], checked.verified ? null : checked.error, delivery.error]);
    });
  }
}

export async function tickPodcastCampaigns(db: Pool, send = services): Promise<void> {
  if (env.NODE_ENV !== 'production' || env.isDevelopment) return;
  const lock = await db.connect();
  let acquired = false;
  try {
    acquired = (await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('athena-podcast-campaigns')) AS locked")).rows[0]?.locked === true;
    if (!acquired) return;
    await recoverPodcastBlogs(db, send);
    const campaigns = (await db.query<PodcastCampaign>(`SELECT ${campaignColumns} FROM podcast_campaigns
      WHERE state='approved' AND plan IS NOT NULL ORDER BY approved_at`)).rows;
    for (const campaign of campaigns) {
      const history = await campaignDeliveries(db, campaign.noteId);
      const post = [...campaign.plan!.posts].sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!))
        .find(item => !history.some(delivery => delivery.identity === podcastIdentity(campaign.noteId, item.id) && delivery.status === 'sent'));
      if (!post?.scheduledAt || Date.parse(post.scheduledAt) > Date.now()) continue;
      const receipt = history.find(delivery => delivery.identity === podcastIdentity(campaign.noteId, post.id));
      if (receipt?.status === 'sending' || receipt?.status === 'unconfirmed') continue;
      if (receipt?.status === 'failed' && (!receipt.nextAttemptAt || Date.parse(receipt.nextAttemptAt) > Date.now())) continue;
      try {
        await publishPodcastPost(db, campaign, post, send);
        await db.query('UPDATE podcast_campaigns SET error=NULL WHERE note_id=$1 AND revision=$2', [campaign.noteId, campaign.revision]);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Podcast publication failed.';
        await db.query('UPDATE podcast_campaigns SET error=$3 WHERE note_id=$1 AND revision=$2 AND error IS DISTINCT FROM $3',
          [campaign.noteId, campaign.revision, message]);
        if (!(error instanceof PublicationDeferred)) console.error('[Podcast] Publication needs attention:', error);
      }
    }
  } finally {
    try { if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext('athena-podcast-campaigns'))"); }
    finally { lock.release(); }
  }
}
