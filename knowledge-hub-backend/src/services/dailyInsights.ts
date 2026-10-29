import type { Pool, PoolClient } from 'pg';
import { digest, normaliseIdentity, londonTime, type DailyInsights } from './dailyInsightsParser.js';
import { dailyReportDate, extractDailyInsights } from './dailyInsightsExtraction.js';

const MEETING_ID_CHARS = 20;

export interface DailyInsightsResult {
  date: string;
  knowledgeDate: string;
  tasksCreated: number;
  tasksUpdated: number;
  tasksPreserved: number;
  meetings: number;
  warnings: string[];
  unchanged: boolean;
}

async function putContent(db: PoolClient, source: string, id: string, title: string, body: string, date: string, metadata: object): Promise<void> {
  await db.query(`INSERT INTO content_items (source, source_id, title, summary, body, published_at, project_context, metadata, tags)
    VALUES ($1,$2,$3,$4,$4,$5,'ibm-msft-practice',$6,'{daily-insights}')
    ON CONFLICT (source, source_id) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary,
      body=EXCLUDED.body, published_at=EXCLUDED.published_at, metadata=EXCLUDED.metadata,
      foundry_indexed_at=NULL, updated_at=NOW()`,
  [source, id, title, body, date, JSON.stringify(metadata)]);
}

type ReportExtractor = (filename: string, text: string) => Promise<DailyInsights>;
const captures = new WeakMap<Pool, Map<string, Promise<DailyInsightsResult>>>();

export function captureDailyInsights(db: Pool, filename: string, text: string, sourcePath: string, sourceModifiedAt?: string,
  extract: ReportExtractor = extractDailyInsights): Promise<DailyInsightsResult> {
  let pending = captures.get(db);
  if (!pending) { pending = new Map(); captures.set(db, pending); }
  const key = digest(JSON.stringify([filename, text, sourcePath, sourceModifiedAt]));
  const existing = pending.get(key);
  if (existing) return existing;
  const work = capture(db, filename, text, sourcePath, sourceModifiedAt, extract).finally(() => { pending.delete(key); });
  pending.set(key, work);
  return work;
}

/** AI runs before the write transaction; unchanged reports do not call the model. */
async function capture(db: Pool, filename: string, text: string, sourcePath: string, sourceModifiedAt: string | undefined,
  extract: ReportExtractor): Promise<DailyInsightsResult> {
  const date = dailyReportDate(filename);
  const hash = digest(text);
  const check = await db.connect();
  let cached: boolean;
  try {
    const receipt = await check.query<{ content_hash: string; source_modified_at: Date | null }>(
      'SELECT content_hash, source_modified_at FROM daily_insights_reports WHERE report_date=$1', [date]);
    const prior = receipt.rows[0];
    cached = prior !== undefined && (prior.content_hash === hash || (sourceModifiedAt !== undefined
      && prior.source_modified_at !== null && new Date(prior.source_modified_at).getTime() > new Date(sourceModifiedAt).getTime()));
  } finally { check.release(); }
  const parsed = cached ? null : await extract(filename, text);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialize the stream, including different report days and desktop windows.
    await client.query('SELECT pg_advisory_xact_lock(741903, 88)');
    const saved = await client.query<{ content_hash: string; result: DailyInsightsResult; source_modified_at: Date | null }>(
      'SELECT content_hash, result, source_modified_at FROM daily_insights_reports WHERE report_date=$1', [date]);
    const previous = saved.rows[0];
    const stale = previous?.source_modified_at != null && sourceModifiedAt !== undefined
      && new Date(previous.source_modified_at).getTime() > new Date(sourceModifiedAt).getTime();
    if (previous !== undefined && (previous.content_hash === hash || stale)) {
      // Even an unchanged capture advances the watermark so a delayed desktop
      // request cannot replace a newer report revision.
      if (!stale && sourceModifiedAt !== undefined) await client.query(`UPDATE daily_insights_reports
        SET source_modified_at=GREATEST(source_modified_at,$2::timestamptz) WHERE report_date=$1`, [date, sourceModifiedAt]);
      await client.query('COMMIT');
      return { ...previous.result, unchanged: true };
    }
    if (parsed === null) throw new Error('Daily Insights report changed during capture; retry to extract the current report');
    const result: DailyInsightsResult = {
      date: parsed.date, knowledgeDate: parsed.knowledgeDate, tasksCreated: 0, tasksUpdated: 0,
      tasksPreserved: 0, meetings: parsed.meetings.length, warnings: [...parsed.warnings], unchanged: false,
    };
    const projects = await client.query<{ id: string; name: string }>('SELECT id, name FROM projects');
    for (const task of parsed.tasks) {
      const project = projects.rows.find(p => normaliseIdentity(p.name) === normaliseIdentity(task.project)
        || normaliseIdentity(p.id) === normaliseIdentity(task.project))?.id ?? null;
      if (project === null) result.warnings.push(task.project
        ? `Project needs filing: ${task.project} — ${task.title}`
        : `Project not stated: ${task.title}`);
      const tracked = await client.query<{ task_id: string | null; snapshot: unknown; last_report_date: string }>(
        `SELECT task_id, snapshot, to_char(last_report_date,'YYYY-MM-DD') AS last_report_date FROM daily_insights_tasks WHERE identity_key=$1`, [task.key]);
      const prior = tracked.rows[0];
      if (prior !== undefined && prior.last_report_date > parsed.date) {
        result.tasksPreserved++;
        continue;
      }
      const body = [
        task.owner && `Owner: ${task.owner}`,
        task.project && `Project: ${task.project}`,
        task.dueText && `Due (as reported): ${task.dueText}`,
        task.source && `Source: ${task.source}`,
        `Daily Insights: ${parsed.date} (${filename})`,
      ].filter(Boolean).join('\n');
      let taskId: string | null = prior?.task_id ?? null;
      let owned = prior?.snapshot != null;
      if (prior === undefined) {
        // Match manual/pre-existing tasks too, regardless of completion/archive state.
        const existing = await client.query<{ id: string }>(`SELECT id FROM tasks
          WHERE trim(regexp_replace(lower(title), '[^[:alnum:]]+', ' ', 'g'))=$1 LIMIT 1`, [normaliseIdentity(task.title)]);
        taskId = existing.rows[0]?.id ?? null;
        if (taskId === null) {
          const made = await client.query<{ id: string }>(`INSERT INTO tasks (title, body, status, project_id, due_date, tags, priority)
            VALUES ($1,$2,'inbox',$3,$4,'{daily-insights}','normal') RETURNING id`, [task.title, body, project, task.due]);
          taskId = made.rows[0]?.id ?? null;
          owned = true;
          result.tasksCreated++;
        } else result.tasksPreserved++;
      } else if (prior.snapshot != null && prior.task_id !== null && prior.last_report_date <= parsed.date) {
        // A full-row snapshot detects every user edit, including status, tags and scheduling.
        const updated = await client.query(`UPDATE tasks SET title=$1, body=$2, project_id=$3, due_date=$4, updated_at=NOW()
          WHERE id=$5 AND status='inbox' AND to_jsonb(tasks)=$6::jsonb RETURNING id`,
        [task.title, body, project, task.due, prior.task_id, JSON.stringify(prior.snapshot)]);
        if ((updated.rowCount ?? 0) > 0) result.tasksUpdated++;
        else { owned = false; result.tasksPreserved++; }
      } else { result.tasksPreserved++; owned = false; }
      // Never adopt a user-edited or pre-existing task as importer-owned.
      const snapshot = owned && taskId !== null
        ? (await client.query<{ snapshot: unknown }>('SELECT to_jsonb(tasks) AS snapshot FROM tasks WHERE id=$1', [taskId])).rows[0]?.snapshot ?? null
        : null;
      await client.query(`INSERT INTO daily_insights_tasks (identity_key,task_id,last_report_date,snapshot,source_detail)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (identity_key) DO UPDATE SET
          last_report_date=GREATEST(daily_insights_tasks.last_report_date,EXCLUDED.last_report_date),
          snapshot=EXCLUDED.snapshot,source_detail=EXCLUDED.source_detail`,
      [task.key, taskId, parsed.date, JSON.stringify(snapshot), JSON.stringify(task)]);
    }
    const calendarIds: string[] = [];
    const meetingOccurrences = new Map<string, number>();
    for (const meeting of parsed.meetings) {
      const baseId = `ibm-daily-${parsed.date}-${meeting.start.replace(':', '')}-${digest(normaliseIdentity(meeting.title)).slice(0, MEETING_ID_CHARS)}`;
      const occurrence = (meetingOccurrences.get(baseId) ?? 0) + 1;
      meetingOccurrences.set(baseId, occurrence);
      const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
      calendarIds.push(id);
      const start = londonTime(parsed.date, meeting.start);
      const end = londonTime(parsed.date, meeting.end);
      const existingCalendar = await client.query(`SELECT 1 FROM content_items WHERE source='graph-calendar'
        AND source_id NOT LIKE 'ibm-daily-%' AND source_id LIKE 'ibm-%'
        AND published_at=$1 AND lower(title)=lower($2) LIMIT 1`, [start, meeting.title]);
      if (existingCalendar.rows.length > 0) continue;
      await putContent(client, 'graph-calendar', id, meeting.title, `${meeting.start}–${meeting.end} ${meeting.flag}`.trim(), start,
        { source: 'ibm-work', capture: 'daily-insights', reportDate: parsed.date, start, end, isAllDay: false, flag: meeting.flag, filename, sourcePath });
    }
    // Reconcile only this importer's complete day, never manually pasted or Graph events.
    await client.query(`DELETE FROM content_items WHERE source='graph-calendar'
      AND source_id LIKE $1 AND NOT(source_id=ANY($2::text[]))`, [`ibm-daily-${parsed.date}-%`, calendarIds]);
    await putContent(client, 'user-upload', `ibm-knowledge-${parsed.knowledgeDate}`,
      `IBM — what I learned ${parsed.knowledgeDate}`, parsed.knowledge, londonTime(parsed.knowledgeDate, '12:00'),
      { capture: 'daily-insights', reportDate: parsed.date, knowledgeDate: parsed.knowledgeDate,
        filename: `IBM-knowledge-${parsed.knowledgeDate}.md`, originalFilename: filename, sourcePath });
    await client.query(`INSERT INTO daily_insights_reports (report_date,content_hash,filename,source_path,report_text,result,source_modified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(report_date) DO UPDATE SET content_hash=EXCLUDED.content_hash,
        filename=EXCLUDED.filename, source_path=EXCLUDED.source_path, report_text=EXCLUDED.report_text,
        result=EXCLUDED.result,source_modified_at=EXCLUDED.source_modified_at,processed_at=NOW()`,
    [parsed.date, hash, filename, sourcePath, text, JSON.stringify(result), sourceModifiedAt ?? null]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
