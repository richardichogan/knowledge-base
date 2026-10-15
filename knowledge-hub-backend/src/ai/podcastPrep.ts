import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getSchedule, type ScheduleEntry } from './contentSchedule.js';
import { workToday } from '../integrations/ibm/ibmMeetings.js';
import { ukClock } from '../sync/ukClock.js';
import { getOutput, saveOutputVersion } from './chatOutputs.js';
import { getSessionHistory } from './chatSessionStore.js';
import { researchPodcast, renderPodcastBrief } from './podcastPrepResearch.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';

export interface PodcastPrepRun {
  recordingDate: string; status: 'running' | 'ready' | 'failed'; sessionId: string;
  outputId: string | null; generatedAt: string | null; acknowledgedAt: string | null;
  warnings: string[]; error: string | null; attempts: number;
}
export interface PodcastPrepStatus { nextRecording: string | null; scheduleWarning: string | null; run: PodcastPrepRun | null; latestBrief: PodcastPrepRun | null }
interface RunRow {
  recording_date: string; status: PodcastPrepRun['status']; session_id: string; output_id: string | null;
  generated_at: Date | null; acknowledged_at: Date | null; warnings: string[]; error: string | null; attempts: number;
}
const SELECT = `SELECT to_char(recording_date,'YYYY-MM-DD') AS recording_date,
  CASE WHEN status='running' AND started_at < NOW()-interval '30 minutes' THEN 'failed' ELSE status END AS status,
  session_id::text,output_id::text,generated_at,acknowledged_at,warnings,
  CASE WHEN status='running' AND started_at < NOW()-interval '30 minutes'
    THEN 'Preparation was interrupted. Retry preparation.' ELSE error END AS error,attempts FROM podcast_prep_runs`;
const runData = (r: RunRow): PodcastPrepRun => ({
  recordingDate: r.recording_date, status: r.status, sessionId: r.session_id, outputId: r.output_id,
  generatedAt: r.generated_at?.toISOString() ?? null, acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
  warnings: r.warnings, error: r.error, attempts: r.attempts,
});

export function podcastRecordingDate(entry: ScheduleEntry | undefined, now = new Date()): string | null {
  if (!entry) return null;
  const date = new Date(`${entry.next}T12:00:00Z`);
  const note = entry.note ?? '';
  // Some schedules explicitly store the Monday release, not the preceding Friday recording.
  if (entry.dateSource !== 'calendar' && date.getUTCDay() === 1
    && /recorded (?:on )?fridays/i.test(note) && /released the following monday/i.test(note)) {
    date.setUTCDate(date.getUTCDate() - 3);
    while (date.toISOString().slice(0, 10) < workToday(now)) date.setUTCDate(date.getUTCDate() + entry.intervalDays);
  }
  while (entry.cancelledDates?.includes(date.toISOString().slice(0, 10))) {
    date.setUTCDate(date.getUTCDate() + entry.intervalDays);
  }
  return date.toISOString().slice(0, 10);
}

export function podcastPrepDue(recording: string | null, now = new Date()): boolean {
  if (!recording || new Date(`${recording}T12:00:00Z`).getUTCDay() !== 5) return false;
  const clock = ukClock(now);
  const tomorrow = new Date(`${workToday(now)}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return clock.weekday === 'Thu' && clock.hour >= 7 && clock.hour < 18 && tomorrow.toISOString().slice(0, 10) === recording;
}

export async function getPodcastPrepStatus(db: Pool, now = new Date()): Promise<PodcastPrepStatus> {
  const schedule = await getSchedule(db, now, false);
  const next = podcastRecordingDate(schedule.podcast, now);
  const [current, latest] = await Promise.all([
    db.query<RunRow>(`${SELECT} WHERE recording_date=$1`, [next]),
    db.query<RunRow>(`${SELECT} WHERE generated_at IS NOT NULL ORDER BY generated_at DESC LIMIT 1`),
  ]);
  return { nextRecording: next,
    scheduleWarning: next === null ? 'No podcast recording date is set. Set it with Athena before automatic preparation can run.'
      : new Date(`${next}T12:00:00Z`).getUTCDay() !== 5 ? 'The saved recording date is not a Friday. Correct it with Athena to enable Thursday preparation.' : null,
    run: current.rows[0] ? runData(current.rows[0]) : null,
    latestBrief: latest.rows[0] ? runData(latest.rows[0]) : null };
}

/** A database lease coordinates manual and scheduled runs, including other replicas. */
export async function claimPodcastPrep(db: Pool, recording: string, manual: boolean): Promise<{ token: string; sessionId: string; outputId: string | null } | null> {
  await db.query(`UPDATE podcast_prep_runs SET status='failed',error='Preparation was interrupted or exceeded its 30-minute lease.',
    retry_at=NOW() WHERE recording_date=$1 AND status='running' AND started_at < NOW()-interval '30 minutes'`, [recording]);
  const token = randomUUID();
  const { rows } = await db.query<{ session_id: string; output_id: string | null }>(
    `INSERT INTO podcast_prep_runs(recording_date,status,claim_token,attempts,started_at,session_id)
     VALUES($1,'running',$2,1,NOW(),$3)
     ON CONFLICT(recording_date) DO UPDATE SET status='running',claim_token=$2,attempts=podcast_prep_runs.attempts+1,
       started_at=NOW(),error=NULL
     WHERE (podcast_prep_runs.status <> 'running' OR podcast_prep_runs.started_at < NOW()-interval '30 minutes')
       AND ($4 OR (podcast_prep_runs.generated_at IS NULL AND podcast_prep_runs.attempts < 3
         AND (podcast_prep_runs.retry_at IS NULL OR podcast_prep_runs.retry_at <= NOW())))
     RETURNING session_id::text,output_id::text`, [recording, token, randomUUID(), manual]);
  return rows[0] ? { token, sessionId: rows[0].session_id, outputId: rows[0].output_id } : null;
}

export async function generatePodcastPrep(db: Pool, manual = false, now = new Date(), background = false,
  prepare = researchPodcast): Promise<PodcastPrepStatus> {
  const status = await getPodcastPrepStatus(db, now);
  const recording = status.nextRecording;
  if (!recording || status.scheduleWarning) {
    if (manual) throw new ValidationError(status.scheduleWarning ?? 'No recording date set');
    return status;
  }
  if (!manual && !podcastPrepDue(recording, now)) return status;
  const claim = await claimPodcastPrep(db, recording, manual);
  if (!claim) {
    if (manual) throw new ConflictError('Podcast preparation is already running. The saved status will update when it finishes.', 'PODCAST_PREP_BUSY');
    return getPodcastPrepStatus(db, now);
  }
  const perform = async (): Promise<void> => {
    try {
      const existing = claim.outputId ? await getOutput(db, claim.outputId) : null;
      const history = await getSessionHistory(db, claim.sessionId);
      const previous = [existing?.versions.at(-1)?.content ?? '', ...history.slice(-8).map((m) => `${m.role}: ${m.content}`)].join('\n').slice(-30_000);
      const result = await prepare(db, recording, previous, now);
      const current = await getSchedule(db, now, false);
      if (podcastRecordingDate(current.podcast, now) !== recording) throw new Error('Recording date changed during preparation; retry for the new recording.');
      const markdown = renderPodcastBrief(recording, result, now);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const lease = await client.query(`SELECT recording_date FROM podcast_prep_runs
          WHERE recording_date=$1 AND claim_token=$2 AND status='running'
            AND started_at >= NOW()-interval '30 minutes' FOR UPDATE`, [recording, claim.token]);
        if (!lease.rows.length) throw new Error('Podcast preparation lease expired; a newer attempt owns this recording.');
        if (existing && claim.outputId) {
          await client.query('SELECT id FROM chat_outputs WHERE id=$1 FOR UPDATE', [claim.outputId]);
          const versions = await client.query<{ version: number }>(
            'SELECT MAX(version) AS version FROM chat_output_versions WHERE output_id=$1', [claim.outputId]);
          if (Number(versions.rows[0]?.version) !== existing.version) {
            throw new ConflictError('The brief was edited during research. Your edits are preserved; refresh again to include them.', 'PODCAST_PREP_EDITED');
          }
        }
        await client.query(`INSERT INTO ai_chat_sessions(id,title,persona,pinned) VALUES($1,$2,'podcast_prep',true)
          ON CONFLICT(id) DO UPDATE SET updated_at=NOW()`, [claim.sessionId, `Podcast prep — ${recording}`]);
        const saved = await saveOutputVersion(db, claim.sessionId, {
          ...(existing ? { outputId: existing.id } : {}), title: `Podcast preparation — ${recording}`,
          kind: 'document', format: 'markdown', content: markdown, author: 'athena',
          note: manual ? 'Prepared/refreshed on request' : 'Thursday scheduled preparation',
        }, client);
        const warnings = [...new Set([...result.warnings, ...result.proposal.warnings])];
        await client.query(`INSERT INTO ai_chat_messages(session_id,role,content,persona,sources)
          VALUES($1,'assistant',$2,'podcast_prep',$3)`, [claim.sessionId,
          `Podcast preparation for ${recording} is saved in Outputs: ${saved.title}. ${result.proposal.topics.length} candidates; ${Math.min(3, result.proposal.topics.length)} recommended discussions.${warnings.length ? ' Research limitations are listed at the top of the brief.' : ''}`,
          ['podcast_preparation']]);
        await client.query(`UPDATE podcast_prep_runs SET status='ready',output_id=$3,generated_at=date_trunc('milliseconds',NOW()),
          evidence=$4,warnings=$5,error=NULL,acknowledged_at=NULL WHERE recording_date=$1 AND claim_token=$2`,
          [recording, claim.token, saved.id, JSON.stringify(result.evidence), JSON.stringify(warnings)]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Podcast preparation failed';
      console.error('[PodcastPrep] Generation failed:', error);
      await db.query(`UPDATE podcast_prep_runs SET status='failed',error=$3,retry_at=NOW()+interval '15 minutes'
        WHERE recording_date=$1 AND claim_token=$2`, [recording, claim.token, message]);
      throw error;
    }
  };
  if (background) {
    void perform().catch((error: unknown) => { console.error('[PodcastPrep] Requested preparation failed:', error); });
  } else await perform();
  return getPodcastPrepStatus(db, now);
}

export async function acknowledgePodcastPrep(db: Pool, recording: string, generatedAt: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recording) || !Number.isFinite(Date.parse(generatedAt))) throw new ValidationError('Invalid podcast brief acknowledgement');
  const { rows } = await db.query(`UPDATE podcast_prep_runs SET acknowledged_at=NOW()
    WHERE recording_date=$1 AND generated_at=$2::timestamptz RETURNING recording_date`, [recording, generatedAt]);
  if (!rows.length) throw new NotFoundError('Podcast brief version');
}
