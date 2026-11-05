import type { Pool } from 'pg';
import { handOff } from '../agents/engine.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { dailyReportDate } from './dailyInsightsExtraction.js';
import { digest } from './dailyInsightsParser.js';
import type { DailyInsightsResult } from './dailyInsights.js';
import type { DailyInsightsStageStore } from './dailyInsightsStages.js';

const MAX_REPORT_CHARS = 250_000;
const MAX_SOURCE_PATH_CHARS = 2_048;
const IMPORT_SPECIALIST = 'metis-daily-insights';
const IMPORT_SUBJECT_TYPE = 'daily-insights-import';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type DailyInsightsSubmission =
  | { status: 'queued'; jobId: string; date: string }
  | { status: 'completed'; result: DailyInsightsResult };

export interface StagedDailyInsightsImport {
  id: string;
  date: string;
  filename: string;
  sourcePath: string;
  report: string;
  sourceModifiedAt: Date;
}

interface ReceiptRow {
  content_hash: string;
  result: DailyInsightsResult;
  source_modified_at: Date | null;
}

export async function submitDailyInsightsImport(db: Pool, input: {
  filename: string;
  report: string;
  sourcePath: string;
  sourceModifiedAt: string;
}): Promise<DailyInsightsSubmission> {
  let date: string;
  try { date = dailyReportDate(input.filename); }
  catch { throw new ValidationError('Daily briefing filename must contain a valid calendar date', { filename: 'invalid date' }); }
  if (!input.report.trim() || input.report.length > MAX_REPORT_CHARS) {
    throw new ValidationError('Daily Insights report is empty or exceeds 250,000 characters');
  }
  if (input.sourcePath.length > MAX_SOURCE_PATH_CHARS || !Number.isFinite(Date.parse(input.sourceModifiedAt))) {
    throw new ValidationError('Daily Insights source path or modification time is invalid');
  }

  const contentHash = digest(input.report);
  const receipt = await db.query<ReceiptRow>(
    'SELECT content_hash, result, source_modified_at FROM daily_insights_reports WHERE report_date=$1', [date],
  );
  const prior = receipt.rows[0];
  const stale = prior?.source_modified_at != null
    && new Date(prior.source_modified_at).getTime() > new Date(input.sourceModifiedAt).getTime();
  if (prior !== undefined && (prior.content_hash === contentHash || stale)) {
    if (!stale && prior.content_hash === contentHash) {
      await db.query(`UPDATE daily_insights_reports SET source_modified_at=GREATEST(source_modified_at,$2::timestamptz)
        WHERE report_date=$1`, [date, input.sourceModifiedAt]);
    }
    return { status: 'completed', result: { ...prior.result, unchanged: true } };
  }

  const staged = await db.query<{ id: string }>(
    `INSERT INTO daily_insights_import_staging
       (report_date,content_hash,filename,source_path,report_text,source_modified_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (report_date,content_hash) DO UPDATE SET
       filename=EXCLUDED.filename,source_path=EXCLUDED.source_path,report_text=EXCLUDED.report_text,
       source_modified_at=GREATEST(daily_insights_import_staging.source_modified_at,EXCLUDED.source_modified_at)
     RETURNING id`,
    [date, contentHash, input.filename, input.sourcePath, input.report, input.sourceModifiedAt],
  );
  const id = staged.rows[0]?.id;
  if (!id) throw new Error('Daily Insights report could not be staged');
  const handoff = await handOff(db, {
    specialist: IMPORT_SPECIALIST,
    subjectId: id,
    input: { importId: id },
    requestedBy: 'app',
  });
  if (handoff.status === 'needs_confirmation') {
    throw new ConflictError('The Daily Insights import requires an unexpected overwrite confirmation.', 'DAILY_INSIGHTS_CONFIRMATION_REQUIRED');
  }
  return { status: 'queued', jobId: handoff.job.id, date };
}

export async function getStagedDailyInsightsImport(db: Pool, id: string): Promise<StagedDailyInsightsImport | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<{
    id: string; date: string; filename: string; source_path: string; report_text: string; source_modified_at: Date;
  }>(`SELECT id,to_char(report_date,'YYYY-MM-DD') AS date,filename,source_path,report_text,source_modified_at
      FROM daily_insights_import_staging WHERE id=$1`, [id]);
  const row = rows[0];
  return row ? {
    id: row.id, date: row.date, filename: row.filename, sourcePath: row.source_path,
    report: row.report_text, sourceModifiedAt: row.source_modified_at,
  } : null;
}

export async function deleteStagedDailyInsightsImport(db: Pool, id: string): Promise<void> {
  await db.query('DELETE FROM daily_insights_import_staging WHERE id=$1', [id]);
}

export function dailyInsightsStageStore(db: Pool, id: string): DailyInsightsStageStore {
  return {
    async read(key): Promise<unknown> {
      const result = await db.query<{ value: unknown }>(
        'SELECT extraction_stages->$2 AS value FROM daily_insights_import_staging WHERE id=$1', [id, key]);
      if (!result.rows.length) throw new NotFoundError('Daily Insights import');
      return result.rows[0]?.value ?? undefined;
    },
    async write(key, value): Promise<void> {
      const result = await db.query(`UPDATE daily_insights_import_staging
        SET extraction_stages=jsonb_set(extraction_stages,ARRAY[$2]::text[],$3::jsonb) WHERE id=$1 RETURNING id`,
      [id, key, JSON.stringify(value)]);
      if (!result.rows.length) throw new NotFoundError('Daily Insights import');
    },
  };
}

export async function resolveDailyInsightsImport(db: Pool, id: string): Promise<{ id: string; title: string; url: string }> {
  const staged = await getStagedDailyInsightsImport(db, id);
  if (!staged) throw new NotFoundError('Daily Insights import');
  return { id: staged.id, title: `Daily Insights import — ${staged.date}`, url: '/library' };
}

export function parseDailyInsightsImportInput(input: Record<string, unknown>): Record<string, unknown> {
  const importId = input['importId'];
  if (typeof importId !== 'string' || !UUID.test(importId)) {
    throw new ValidationError('Metis requires a valid staged Daily Insights report.');
  }
  return { importId };
}

export const dailyInsightsImportSpecialist = { id: IMPORT_SPECIALIST, subjectType: IMPORT_SUBJECT_TYPE } as const;
