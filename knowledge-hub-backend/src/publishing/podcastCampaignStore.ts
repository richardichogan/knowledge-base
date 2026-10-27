import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { getFoundryClient } from '../ai/foundryClient.js';
import { noteMarkdown } from '../services/noteMarkdown.js';
import { parseNoteContent } from '../utils/noteContent.js';
import { getLinkedInMember, linkedinConfigured } from '../integrations/social/linkedin.js';
import { blueskyConfigured } from '../integrations/social/bluesky.js';
import { deliveryColumns, event, feeds, transaction } from './store.js';
import { destinationAccount, inWindow } from './delivery.js';
import { requestEditorialJson } from './editorial.js';
import type { Delivery } from './contracts.js';
import {
  PODCAST_LIMITS, episodeLinksFromNote, parseEpisodeLinks, parsePodcastPlan, podcastPlanIssues, parsePodcastWindow,
  type PodcastCampaign, type PodcastCampaignDetail, type PodcastPlan, type PodcastPost,
} from './podcastCampaign.js';
import { materialisePodcastSelections, podcastSourceBlocks, podcastSelectionSchema, PODCAST_SELECTION_INSTRUCTIONS } from './podcastCampaignSource.js';

type Db = Pick<Pool, 'query'>;
export const campaignColumns = `note_id AS "noteId",revision,links,plan,source_revision AS "sourceRevision",
  state,approved_at::text AS "approvedAt",error`;
interface EpisodeNote { content: string; revision: number }
async function episodeNote(db: Db, noteId: string): Promise<EpisodeNote> {
  const note = (await db.query<EpisodeNote>("SELECT content,revision FROM notes WHERE id=$1 AND status='active'", [noteId])).rows[0];
  if (!note) throw new NotFoundError('Show Notes');
  if (parseNoteContent(note.content).contentType !== 'podcast-show-notes') throw new ValidationError('Podcast campaigns belong to Podcast show notes.');
  return note;
}
async function campaignIssues(db: Db, plan: PodcastPlan | null): Promise<string[]> {
  const issues = podcastPlanIssues(plan);
  if (!plan) return issues;
  const settings = await feeds(db);
  for (const post of plan.posts) {
    if (!post.scheduledAt) continue;
    const policy = settings.find(feed => feed.id === (post.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin'))?.policy;
    if (!policy || !inWindow(policy, new Date(post.scheduledAt))) issues.push(`${post.label}: its time is outside the configured publishing window.`);
  }
  return issues;
}
export async function campaignDeliveries(db: Db, noteId: string): Promise<Delivery[]> {
  return (await db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries
    WHERE identity LIKE $1 ORDER BY attempted_at`, [`podcast:${noteId}:%`])).rows;
}
export async function getPodcastCampaign(db: Pool, noteId: string): Promise<PodcastCampaignDetail> {
  const note = await episodeNote(db, noteId);
  const saved = (await db.query<PodcastCampaign>(`SELECT ${campaignColumns} FROM podcast_campaigns WHERE note_id=$1`, [noteId])).rows[0];
  const campaign: PodcastCampaign = saved ?? {
    noteId, revision: 0, links: episodeLinksFromNote(note.content), plan: null, sourceRevision: null,
    state: 'draft', approvedAt: null, error: null,
  };
  const sourceChanged = campaign.sourceRevision !== null && campaign.sourceRevision !== note.revision;
  const issues = campaign.state === 'draft' ? await campaignIssues(db, campaign.plan) : [];
  if (campaign.state === 'draft' && sourceChanged) issues.push('The saved Show Notes changed. Prepare the campaign again before approving.');
  return { ...campaign, deliveries: await campaignDeliveries(db, noteId), issues, sourceChanged,
    automaticDelivery: env.NODE_ENV === 'production' && !env.isDevelopment };
}
async function lockedCampaign(c: PoolClient, noteId: string, revision: unknown): Promise<PodcastCampaign> {
  const current = (await c.query<PodcastCampaign>(`SELECT ${campaignColumns} FROM podcast_campaigns WHERE note_id=$1 FOR UPDATE`, [noteId])).rows[0];
  if (!current) throw new ValidationError('Save the episode links before preparing a campaign.');
  if (current.revision !== revision) throw new ConflictError('The campaign changed. Reload before continuing.', 'PODCAST_CONFLICT');
  return current;
}
async function assertCanPrepare(db: Db, campaign: PodcastCampaign): Promise<void> {
  if (campaign.state === 'approved') throw new ValidationError('Pause the campaign before changing its links or preparing another version.');
  const delivered = (await campaignDeliveries(db, campaign.noteId)).some(delivery => ['sent', 'sending', 'unconfirmed'].includes(delivery.status));
  if (delivered) throw new ValidationError('Publication has started. Its approved copy and links are locked to prevent duplicate or changed posts. You can pause or resume the remaining deliveries.');
}
export async function savePodcastLinks(db: Pool, noteId: string, revision: unknown, value: unknown, actor: string): Promise<PodcastCampaignDetail> {
  const links = parseEpisodeLinks(value);
  await episodeNote(db, noteId);
  await transaction(db, async c => {
    if (revision === 0) {
      const created = await c.query(`INSERT INTO podcast_campaigns(note_id,links) VALUES($1,$2)
        ON CONFLICT DO NOTHING RETURNING note_id`, [noteId, JSON.stringify(links)]);
      if (!created.rowCount) throw new ConflictError('Episode links were saved elsewhere. Reload before continuing.', 'PODCAST_CONFLICT');
    } else {
      const campaign = await lockedCampaign(c, noteId, revision);
      await assertCanPrepare(c, campaign);
      await c.query(`UPDATE podcast_campaigns SET links=$2,plan=NULL,source_revision=NULL,state='draft',
        revision=revision+1,approved_by=NULL,approved_at=NULL,error=NULL,updated_at=NOW() WHERE note_id=$1`, [noteId, JSON.stringify(links)]);
    }
    await event(c, null, actor, 'podcast-links-saved', { noteId });
  });
  return getPodcastCampaign(db, noteId);
}

export async function preparePodcastCampaign(db: Pool, noteId: string, revision: unknown, actor: string, requestedWindow?: unknown): Promise<PodcastCampaignDetail> {
  const lock = await db.connect();
  const lockKey = `podcast-prepare:${noteId}`;
  let acquired = false;
  try {
    acquired = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockKey])).rows[0]?.locked === true;
    if (!acquired) throw new ConflictError('This episode is already being prepared. Reload its Campaign tab shortly.', 'PODCAST_BUSY');
    const campaign = await transaction(db, async c => {
      const current = await lockedCampaign(c, noteId, revision);
      await assertCanPrepare(c, current);
      return current;
    });
    const links = parseEpisodeLinks(campaign.links, true);
    const window = parsePodcastWindow(requestedWindow ?? campaign.plan?.window);
    if (!linkedinConfigured() || !blueskyConfigured() || !env.BLOG_POSTS_API_KEY) throw new ValidationError('Connect Blog, personal LinkedIn and Bluesky before preparing this publishing campaign.');
    const member = await getLinkedInMember();
    const note = await episodeNote(db, noteId);
    const markdown = await noteMarkdown(note.content, noteId);
    if (markdown.length > PODCAST_LIMITS.source) throw new ValidationError('The Show Notes exceed the campaign reading limit. Keep the episode campaign in its own note.');
    const settings = await feeds(db);
    const accountMap = { blog: destinationAccount('blog'), linkedin: member.id, bluesky: destinationAccount('bluesky') };
    const output = await requestEditorialJson(getFoundryClient('discover-editorial'), PODCAST_SELECTION_INSTRUCTIONS, {
      blocks: podcastSourceBlocks(markdown).map((markdown, index) => ({ index, markdown })),
      requestedWindow: window, now: new Date().toISOString(),
      windows: settings.map(feed => ({ channel: feed.id, ...feed.policy })),
    }, PODCAST_LIMITS.selectionTokens, podcastSelectionSchema);
    const plan = parsePodcastPlan(materialisePodcastSelections(markdown, output), links, accountMap, member.name, { authored: true, window });
    await transaction(db, async c => {
      const current = await lockedCampaign(c, noteId, revision);
      await assertCanPrepare(c, current);
      await c.query('SELECT id FROM notes WHERE id=$1 FOR SHARE', [noteId]);
      if ((await episodeNote(c, noteId)).revision !== note.revision) throw new ConflictError('The Show Notes changed during preparation. Prepare again from the saved version.', 'PODCAST_CONFLICT');
      await c.query(`UPDATE podcast_campaigns SET plan=$2,source_revision=$3,revision=revision+1,state='draft',
        approved_by=NULL,approved_at=NULL,error=NULL,updated_at=NOW() WHERE note_id=$1`, [noteId, JSON.stringify(plan), note.revision]);
      await event(c, null, actor, 'podcast-campaign-prepared', { noteId, sourceRevision: note.revision, posts: plan.posts.length });
    });
    return getPodcastCampaign(db, noteId);
  } finally {
    try { if (acquired) await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]); }
    finally { lock.release(); }
  }
}

export async function decidePodcastCampaign(db: Pool, noteId: string, revision: unknown, action: unknown, actor: string): Promise<PodcastCampaignDetail> {
  if (action !== 'approve' && action !== 'pause' && action !== 'resume') throw new ValidationError('Choose approve, pause or resume.');
  const member = action === 'pause' ? null : await getLinkedInMember();
  await transaction(db, async c => {
    const current = await lockedCampaign(c, noteId, revision);
    await c.query('SELECT id FROM notes WHERE id=$1 FOR SHARE', [noteId]);
    const note = await episodeNote(c, noteId);
    if (!current.plan) throw new ValidationError('Prepare the campaign first.');
    if (action === 'approve') {
      if (current.state !== 'draft') throw new ValidationError('Only a draft campaign can be approved.');
      const issues = await campaignIssues(c, current.plan);
      if (current.sourceRevision !== note.revision) issues.push('The Show Notes changed. Prepare the campaign again.');
      if (issues.length) throw new ValidationError(issues.join('\n'));
    }
    if (action === 'resume' && (current.state !== 'paused' || !current.approvedAt)) throw new ValidationError('Only a previously approved, paused campaign can resume.');
    if (action === 'pause' && current.state !== 'approved') throw new ValidationError('Only an approved campaign can be paused.');
    if (action !== 'pause') {
      if (!env.BLOG_POSTS_API_KEY || !blueskyConfigured()) throw new ValidationError('Reconnect Blog and Bluesky before scheduling.');
      if (member?.id !== current.plan.accounts.linkedin || destinationAccount('bluesky') !== current.plan.accounts.bluesky
        || destinationAccount('blog') !== current.plan.accounts.blog) throw new ValidationError('A publishing account changed. The campaign cannot send to a different account.');
      parseEpisodeLinks(current.links, true);
    }
    await c.query(`UPDATE podcast_campaigns SET state=$2,revision=revision+1,error=NULL,
      approved_at=CASE WHEN $3 THEN NOW() ELSE approved_at END,approved_by=CASE WHEN $3 THEN $4 ELSE approved_by END,
      updated_at=NOW() WHERE note_id=$1`, [noteId, action === 'pause' ? 'paused' : 'approved', action === 'approve', actor]);
    await event(c, null, actor, `podcast-campaign-${action}`, { noteId, revision, sourceRevision: current.sourceRevision });
  });
  return getPodcastCampaign(db, noteId);
}

export async function podcastDeliveryPost(db: Db, identity: string): Promise<PodcastPost | null> {
  const match = /^podcast:([a-f0-9-]{36}):([a-f0-9-]{36})$/i.exec(identity);
  if (!match) return null;
  const [, noteId, postId] = match;
  const row = (await db.query<{ plan: PodcastPlan | null }>('SELECT plan FROM podcast_campaigns WHERE note_id=$1', [noteId])).rows[0];
  return row?.plan?.posts.find(post => post.id === postId) ?? null;
}
