import type { Pool } from 'pg';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../config/constants.js';
import { localClock, occurrences } from '../jobs/schedule.js';
import { inWindow, slotBlock } from './delivery.js';
import { PUBLISH_LIMITS, type Delivery, type Draft, type PublishingFeed } from './contracts.js';
import { deliveryColumns, draftColumns, event, feeds, transaction } from './store.js';

const LEAD_MINUTES = 15;
const PLANNING_DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const CLOCK_DIGITS = 2;
const LINKEDIN_ORDER = 1;
const BLUESKY_ORDER = 2;
const LEAD = LEAD_MINUTES * MS_PER_MINUTE;
const PLANNING_HOURS = PLANNING_DAYS * HOURS_PER_DAY;
export interface ScheduledPost {
  draftId: string; topicId: string; title: string; destination: Draft['destination']; version: number;
  scheduledAt: string | null; timezone: string; paused: boolean; reason: string;
}
interface Candidate extends Draft { title: string; topicState: string; scheduledAt: string | null; scheduleReason: string | null }
interface Booking { draftId: string; destination: Draft['destination']; account: string; at: Date }
const scheduleCandidates = `SELECT ${draftColumns.split(',').map(column => {
  const trimmed = column.trim();
  return `d.${trimmed}`;
}).join(',')},t.title,t.state AS "topicState",s.scheduled_at::text AS "scheduledAt",s.reason AS "scheduleReason"
  FROM publishing_drafts d JOIN publishing_topics t ON t.id=d.topic_id
  LEFT JOIN publishing_schedule s ON s.draft_id=d.id AND s.version=d.version`;

function feedFor(draft: Draft, settings: PublishingFeed[]): PublishingFeed {
  const feed = settings.find(f => f.id === (draft.destination === 'bluesky' ? 'bluesky' : 'blog-linkedin'));
  if (!feed) throw new Error('Publishing feed settings are missing.');
  return feed;
}
function completed(draft: Draft, history: Delivery[]): boolean {
  return history.some(d => d.draftId === draft.id && d.version === draft.version && ['sent', 'sending', 'unconfirmed'].includes(d.status));
}
function readiness(draft: Candidate): string | null {
  if (draft.held || draft.topicState !== 'ready') return 'Held; resolve the editorial findings before scheduling.';
  if (draft.approval !== 'approved') return 'Waiting for approval of this exact version.';
  if (draft.review !== 'pass') return 'Waiting for a passed editorial review.';
  if (typeof draft.content.account !== 'string' || !draft.content.account.trim() || draft.content.account === '(not connected)') {
    return 'Destination account is not connected; rebind it and approve the new version.';
  }
  return null;
}
const destinationNames = { blog: 'Blog', linkedin: 'LinkedIn', bluesky: 'Bluesky' };
function packageBlocker(draft: Draft, candidates: Candidate[]): string | null {
  if (draft.variant !== 'blog') return null;
  for (const destination of ['blog', 'linkedin'] as const) {
    const companion = candidates.find(d => d.topicId === draft.topicId && d.destination === destination);
    if (!companion) return `${destinationNames[destination]} draft is missing. Complete the package before scheduling.`;
    const blocker = readiness(companion);
    if (blocker) return `${destinationNames[destination]} v${companion.version}: ${blocker}${
      companion.approval === 'pending' && !companion.held && companion.review === 'pass'
        ? ' Read the package and choose Send package for scheduling once to approve Blog and LinkedIn together.' : ''}`;
  }
  return null;
}
function slots(feed: PublishingFeed, destination: Draft['destination'], from: Date, until: Date): Date[] {
  const cap = destination === 'bluesky' ? PUBLISH_LIMITS.blueskyCap : PUBLISH_LIMITS.linkedinCap;
  const minimum = destination === 'bluesky' ? PUBLISH_LIMITS.blueskySpacingHours : PUBLISH_LIMITS.linkedinSpacingHours;
  const step = Math.max(minimum, (feed.policy.endHour - feed.policy.startHour) / cap);
  const times: string[] = [];
  for (let i = 0; i < cap; i++) {
    const minutes = Math.round((feed.policy.startHour + i * step) * MINUTES_PER_HOUR);
    if (minutes >= feed.policy.endHour * MINUTES_PER_HOUR) break;
    times.push(`${String(Math.floor(minutes / MINUTES_PER_HOUR)).padStart(CLOCK_DIGITS, '0')}:${String(minutes % MINUTES_PER_HOUR).padStart(CLOCK_DIGITS, '0')}`);
  }
  return occurrences({ ...feed.policy, times }, from, until);
}

export function planSchedule(candidates: Candidate[], settings: PublishingFeed[], history: Delivery[], now = new Date()): ScheduledPost[] {
  const bookings: Booking[] = [];
  const planned = new Map<string, ScheduledPost>();
  const approved = candidates.filter(d => d.approval === 'approved' && !completed(d, history));
  const ordered = [...approved].sort((a, b) => {
    const rank = (d: Draft): number => d.destination === 'blog' ? 0 : d.destination === 'linkedin' ? LINKEDIN_ORDER : BLUESKY_ORDER;
    return rank(a) - rank(b) || (a.scheduledAt ?? 'z').localeCompare(b.scheduledAt ?? 'z');
  });
  function available(draft: Draft, at: Date): boolean {
    const account = String(draft.content.account);
    const relevant = history.filter(d => d.destination === draft.destination && d.account === account);
    if (slotBlock(relevant, draft.destination, at)) return false;
    const reserved = bookings.filter(b => b.draftId !== draft.id && b.destination === draft.destination && b.account === account);
    const spacing = draft.destination === 'bluesky' ? PUBLISH_LIMITS.blueskySpacingHours : PUBLISH_LIMITS.linkedinSpacingHours;
    const cap = draft.destination === 'bluesky' ? PUBLISH_LIMITS.blueskyCap : PUBLISH_LIMITS.linkedinCap;
    const day = localClock(at, 'Europe/London').day;
    return !reserved.some(b => Math.abs(b.at.getTime() - at.getTime()) < spacing * MS_PER_HOUR)
      && reserved.filter(b => localClock(b.at, 'Europe/London').day === day).length
        + relevant.filter(d => d.status === 'sent' && d.publishedAt && localClock(new Date(d.publishedAt), 'Europe/London').day === day).length < cap;
  }
  for (const draft of ordered) {
    const feed = feedFor(draft, settings);
    let reason = readiness(draft);
    if (!reason && draft.variant === 'source' && candidates.some(d => d.topicId === draft.topicId && d.destination === 'blog')) {
      reason = 'Source promotion is superseded by the blog package.';
    }
    const pair = candidates.filter(d => d.topicId === draft.topicId && ['blog', 'linkedin'].includes(d.destination));
    if (!reason) reason = packageBlocker(draft, candidates);
    const retry = history.find(d => d.draftId === draft.id && d.version === draft.version && d.status === 'failed');
    if (!reason && retry && !retry.nextAttemptAt) reason = 'Delivery failed; reconcile it in History before retrying.';
    const unresolved = history.some(d => d.destination === draft.destination && d.account === String(draft.content.account)
      && ['sending', 'unconfirmed'].includes(d.status));
    if (!reason && unresolved) reason = 'An earlier delivery is unresolved; reconcile it in History.';
    const earliest = Math.max(now.getTime() + LEAD, retry?.nextAttemptAt ? Date.parse(retry.nextAttemptAt) : 0);
    const blog = pair.find(d => d.destination === 'blog');
    const publishedBlog = history.find(d => d.topicId === draft.topicId && d.destination === 'blog' && d.status === 'sent' && d.receipt?.verifiedAt);
    const blogPlan = blog ? planned.get(blog.id) : undefined;
    let dependency = 0;
    if (!reason && draft.variant === 'blog' && draft.destination !== 'blog' && !publishedBlog) {
      if (!blogPlan?.scheduledAt) reason = 'Waiting for the blog to be scheduled and its public URL verified.';
      else dependency = Date.parse(blogPlan.scheduledAt) + LEAD;
    }
    let at: Date | undefined;
    if (!reason) {
      const until = new Date(now.getTime() + PLANNING_HOURS * MS_PER_HOUR);
      const prior = draft.scheduledAt ? new Date(draft.scheduledAt) : undefined;
      const due = prior && prior.getTime() >= now.getTime() - LEAD && prior.getTime() >= dependency
        && (!retry?.nextAttemptAt || prior.getTime() >= Date.parse(retry.nextAttemptAt));
      const options = [
        ...(due ? [prior] : []),
        ...(draft.destination === 'linkedin' && dependency >= earliest ? [new Date(dependency)] : []),
        ...slots(feed, draft.destination, new Date(Math.max(earliest, dependency)), until),
      ];
      const hook = pair.find(d => d.destination === 'linkedin');
      at = options.find(time => time < until && inWindow(feed.policy, time) && available(draft, time)
        && (draft.destination !== 'blog' || (hook
          && inWindow(feed.policy, new Date(time.getTime() + LEAD)) && available(hook, new Date(time.getTime() + LEAD)))));
      if (!at) reason = 'No slot in the next 30 days fits the publishing window, daily limits, spacing and package dependencies. Adjust the publishing window or resolve earlier queued items, then refresh. This draft remains queued.';
      else {
        const reservation = bookings.find(b => b.draftId === draft.id);
        if (reservation) reservation.at = at;
        else bookings.push({ draftId: draft.id, destination: draft.destination, account: String(draft.content.account), at });
        if (draft.destination === 'blog' && hook) bookings.push({
          draftId: hook.id, destination: 'linkedin', account: String(hook.content.account), at: new Date(at.getTime() + LEAD),
        });
      }
    }
    planned.set(draft.id, {
      draftId: draft.id, topicId: draft.topicId, title: String(draft.content.title ?? draft.title),
      destination: draft.destination, version: draft.version, scheduledAt: at?.toISOString() ?? null,
      timezone: feed.policy.timezone, paused: !feed.enabled,
      reason: reason ?? (draft.variant === 'blog' && draft.destination !== 'blog' && !publishedBlog
        ? 'After the blog is live and its public URL is verified.' : 'Approved; sends at this time.'),
    });
  }
  return [...planned.values()].sort((a, b) => (a.scheduledAt ?? 'z').localeCompare(b.scheduledAt ?? 'z'));
}

export async function refreshSchedule(db: Pool): Promise<void> {
  await transaction(db, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('athena-publishing-schedule'))");
    const settings = (await c.query<PublishingFeed>('SELECT id,enabled,revision,policy FROM publishing_feeds ORDER BY id FOR UPDATE')).rows;
    const candidates = (await c.query<Candidate>(`${scheduleCandidates} ORDER BY d.created_at,d.id`)).rows;
    const history = (await c.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries
      WHERE published_at>NOW()-INTERVAL '2 days' OR status<>'sent'
        OR draft_id IN (SELECT id FROM publishing_drafts WHERE approval='approved')`)).rows;
    const plan = planSchedule(candidates, settings, history);
    await c.query('DELETE FROM publishing_schedule WHERE NOT(draft_id=ANY($1::uuid[]))', [plan.map(p => p.draftId)]);
    for (const post of plan) {
      const changed = await c.query(`INSERT INTO publishing_schedule(draft_id,version,scheduled_at,reason)
        VALUES($1,$2,$3,$4) ON CONFLICT(draft_id) DO UPDATE SET version=$2,scheduled_at=$3,reason=$4,updated_at=NOW()
        WHERE (publishing_schedule.version,publishing_schedule.scheduled_at,publishing_schedule.reason)
          IS DISTINCT FROM ($2::integer,$3::timestamptz,$4::text) RETURNING draft_id`,
      [post.draftId, post.version, post.scheduledAt, post.reason]);
      if (changed.rowCount) await event(c, post.topicId, 'scheduler', 'schedule-updated', post);
    }
  });
}

export async function listSchedule(db: Pool): Promise<ScheduledPost[]> {
  const settings = await feeds(db);
  const candidates = (await db.query<Candidate>(`${scheduleCandidates}
    WHERE d.topic_id IN(SELECT topic_id FROM publishing_drafts WHERE approval='approved')
    ORDER BY s.scheduled_at NULLS LAST,d.created_at`)).rows;
  const history = (await db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries
    WHERE draft_id=ANY($1::uuid[])`, [candidates.map(d => d.id)])).rows;
  return candidates.filter(d => d.approval === 'approved' && !completed(d, history)).map(d => {
    const feed = feedFor(d, settings);
    const blocker = readiness(d) ?? packageBlocker(d, candidates);
    return { draftId: d.id, topicId: d.topicId, title: String(d.content.title ?? d.title), destination: d.destination,
      version: d.version, scheduledAt: blocker || !d.scheduledAt ? null : new Date(d.scheduledAt).toISOString(), timezone: feed.policy.timezone,
      paused: !feed.enabled, reason: blocker ?? d.scheduleReason ?? 'Refresh the schedule to assign a slot.' };
  }).sort((a, b) => (a.scheduledAt ?? 'z').localeCompare(b.scheduledAt ?? 'z'));
}
