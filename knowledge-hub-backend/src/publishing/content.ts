import type { Pool } from 'pg';
import { object, type JobRun } from '../jobs/contracts.js';
import { activeJobRunsSql, jobSlots, listSchedule, type JobSlot, type ScheduledPost } from './schedule.js';
import { deliveryColumns } from './store.js';
import type { Delivery } from './contracts.js';
import { listPodcastSchedule } from './podcastCampaignStore.js';
import type { ScheduledPodcastPost } from './podcastCampaign.js';

export interface PublishingJobPost extends Omit<ScheduledPost, 'topicId'> {
  jobId: string; runId: string; copy: string;
  blog: Record<string, unknown> | null;
}

export function jobPublishingPosts(run: JobRun, slots: JobSlot[] = []): PublishingJobPost[] {
  const sources = Array.isArray(run.artifacts.sources) ? run.artifacts.sources.map(value => {
    const source = object(value);
    return { id: typeof source.id === 'string' ? source.id : '',
      title: typeof source.title === 'string' ? source.title : 'Saved job evidence',
      url: typeof source.url === 'string' ? source.url : null };
  }) : [];
  const blog = run.artifacts.blog ? object(run.artifacts.blog) : null;
  return run.definition.outputs.flatMap(destination => {
    if (destination !== 'blog' && destination !== 'linkedin' && destination !== 'bluesky') return [];
    const step = run.steps.find(item => item.key === destination);
    if (step?.status === 'succeeded') return [];
    const copy = run.artifacts[destination];
    const slot = slots.find(item => item.draftId === `job:${run.id}:${destination}`);
    const held = slot && slot.at.getTime() > Math.max(Date.parse(run.scheduledAt), Date.now());
    return [{
      draftId: `job:${run.id}:${destination}`, jobId: run.jobId, runId: run.id,
      title: typeof blog?.title === 'string' ? blog.title : run.definition.name,
      destination, version: run.revision, scheduledAt: (slot?.at ?? new Date(run.scheduledAt)).toISOString(),
      timezone: run.definition.schedule.timezone, paused: false,
      origin: run.definition.kind === 'weekly-microsoft' ? 'Microsoft weekly digest' : 'Scheduled publishing job',
      approved: run.status !== 'awaiting-approval' && (run.approvedAt !== null || run.definition.approval === 'automatic'),
      status: step?.status === 'unconfirmed' ? 'Awaiting confirmation'
        : step?.status === 'failed' ? 'Needs attention' : held ? 'Scheduled' : run.status,
      reason: step?.error ?? (held ? (destination === 'bluesky' ? 'Next Bluesky slot: after LinkedIn and the 2-hour spacing since the last Bluesky post.'
        : 'Next LinkedIn slot: 3 hours after the last LinkedIn post. The blog publishes first, then LinkedIn.')
        : typeof run.artifacts.error === 'string' ? run.artifacts.error
        : run.status === 'awaiting-approval' ? 'Awaiting approval in Jobs; this date is not permission to publish.'
          : `Job run: ${run.status}. Publishing is managed by the saved job, not the Discover schedule.`),
      sources, copy: typeof copy === 'string' ? copy : '',
      blog: destination === 'blog' ? blog : null,
    }];
  });
}

export async function listPublishingContent(db: Pool): Promise<Array<ScheduledPost | ScheduledPodcastPost | PublishingJobPost>> {
  const [regular, podcast, runs, history] = await Promise.all([
    listSchedule(db, true), listPodcastSchedule(db, true),
    db.query<JobRun>(activeJobRunsSql),
    db.query<Delivery>(`SELECT ${deliveryColumns} FROM publishing_deliveries
      WHERE destination IN ('linkedin','bluesky') AND status='sent' AND published_at>NOW()-INTERVAL '2 days'`),
  ]);
  return [...regular, ...podcast, ...runs.rows.flatMap(run => jobPublishingPosts(run, jobSlots(run, history.rows)))]
    .sort((a, b) => (a.scheduledAt ?? 'z').localeCompare(b.scheduledAt ?? 'z'));
}
