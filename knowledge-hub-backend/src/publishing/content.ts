import type { Pool } from 'pg';
import { object, type JobRun } from '../jobs/contracts.js';
import { runColumns } from '../jobs/store.js';
import { listSchedule, type ScheduledPost } from './schedule.js';
import { listPodcastSchedule } from './podcastCampaignStore.js';
import type { ScheduledPodcastPost } from './podcastCampaign.js';

const RUN_LIMIT = 50;
export interface PublishingJobPost extends Omit<ScheduledPost, 'topicId'> {
  jobId: string; runId: string; copy: string;
  blog: Record<string, unknown> | null;
}

export function jobPublishingPosts(run: JobRun): PublishingJobPost[] {
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
    return [{
      draftId: `job:${run.id}:${destination}`, jobId: run.jobId, runId: run.id,
      title: typeof blog?.title === 'string' ? blog.title : run.definition.name,
      destination, version: run.revision, scheduledAt: new Date(run.scheduledAt).toISOString(),
      timezone: run.definition.schedule.timezone, paused: false,
      origin: run.definition.kind === 'weekly-microsoft' ? 'Microsoft weekly digest' : 'Scheduled publishing job',
      approved: run.status !== 'awaiting-approval' && (run.approvedAt !== null || run.definition.approval === 'automatic'),
      status: step?.status === 'unconfirmed' ? 'Awaiting confirmation'
        : step?.status === 'failed' ? 'Needs attention' : run.status,
      reason: step?.error ?? (typeof run.artifacts.error === 'string' ? run.artifacts.error
        : run.status === 'awaiting-approval' ? 'Awaiting approval in Jobs; this date is not permission to publish.'
          : `Job run: ${run.status}. Publishing is managed by the saved job, not the Discover schedule.`),
      sources, copy: typeof copy === 'string' ? copy : '',
      blog: destination === 'blog' ? blog : null,
    }];
  });
}

export async function listPublishingContent(db: Pool): Promise<Array<ScheduledPost | ScheduledPodcastPost | PublishingJobPost>> {
  const [regular, podcast, runs] = await Promise.all([
    listSchedule(db, true), listPodcastSchedule(db, true),
    db.query<JobRun>(`SELECT ${runColumns} FROM managed_job_runs
      WHERE NOT preview AND definition->'outputs' ?| ARRAY['blog','linkedin','bluesky']
        AND status NOT IN ('succeeded','rejected')
      ORDER BY scheduled_at DESC LIMIT $1`, [RUN_LIMIT]),
  ]);
  return [...regular, ...podcast, ...runs.rows.flatMap(jobPublishingPosts)]
    .sort((a, b) => (a.scheduledAt ?? 'z').localeCompare(b.scheduledAt ?? 'z'));
}
