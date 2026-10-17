import { microsoftRelevanceSql } from '../../utils/microsoftRelevance.js';

/**
 * How well a Discover article suits each publishing format, 0 (no) to 3 (strong).
 * New articles get the scorer's own judgement (`metadata.formatFit`); articles scored
 * before that existed fall back to a rule derived from their stored dimensions, computed
 * live in SQL so no rescore or backfill is needed.
 */

export const CONTENT_FORMATS = ['newsletter', 'podcast', 'fullBlog', 'quickBlog', 'social'] as const;
export type ContentFormat = typeof CONTENT_FORMATS[number];
export type FormatFit = Record<ContentFormat, number>;

export function isContentFormat(value: string): value is ContentFormat {
  return (CONTENT_FORMATS as readonly string[]).includes(value);
}

/** Clamps the model's formatFit to whole numbers 0-3; missing or invalid output returns null. */
export function normaliseFormatFit(raw: unknown): FormatFit | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const fit = {} as FormatFit;
  for (const format of CONTENT_FORMATS) {
    const value = Number(source[format]);
    if (!Number.isFinite(value)) return null;
    fit[format] = Math.max(0, Math.min(3, Math.round(value)));
  }
  return fit;
}

function derivedFitSql(alias: string, format: ContentFormat): string {
  const m = `${alias}.metadata`;
  const c = `COALESCE((${m}->>'compositeScore')::int, 0)`;
  const n = `COALESCE((${m}->>'novelty')::int, 0)`;
  const s = `COALESCE((${m}->>'strategicSignificance')::int, 0)`;
  const d = `COALESCE((${m}->>'analyticalDepth')::int, 0)`;
  const a = `COALESCE((${m}->>'audienceFit')::int, 0)`;
  const p = `${m}->>'platform'`;
  const rules: Record<ContentFormat, string> = {
    newsletter: `CASE WHEN ${p} = 'Newsletter Candidate' OR ${c} >= 7 THEN 3 WHEN ${c} >= 6 THEN 2 WHEN ${c} >= 5 THEN 1 ELSE 0 END`,
    podcast: `CASE WHEN ${p} IN ('Podcast Topic', 'Podcast') THEN 3 WHEN ${s} = 2 AND ${c} >= 6 THEN 2 WHEN ${s} >= 1 AND ${c} >= 5 THEN 1 ELSE 0 END`,
    fullBlog: `CASE WHEN ${p} = 'Full Blog Post' OR (${d} = 2 AND ${c} >= 8) THEN 3 WHEN ${d} = 2 AND ${c} >= 6 THEN 2 WHEN ${d} >= 1 AND ${c} >= 6 THEN 1 ELSE 0 END`,
    quickBlog: `CASE WHEN ${n} >= 2 AND ${s} >= 1 AND ${c} >= 6 THEN 3 WHEN ${n} >= 2 AND ${c} >= 5 THEN 2 WHEN ${c} >= 5 THEN 1 ELSE 0 END`,
    social: `CASE WHEN ${c} >= 5 AND ${a} >= 2 AND ${n} >= 2 THEN 3 WHEN ${c} >= 4 THEN 2 WHEN ${c} >= 3 THEN 1 ELSE 0 END`,
  };
  return `(CASE WHEN ${alias}.relevance_explanation IS NULL OR ${p} = 'Archive' THEN 0 ELSE ${rules[format]} END)`;
}

/** SQL for one format's 0-3 fit: the scorer's value when present, else the derived rule. */
export function formatFitSql(alias: string, format: ContentFormat): string {
  const fit = `COALESCE((${alias}.metadata->'formatFit'->>'${format}')::int, ${derivedFitSql(alias, format)})`;
  // Gate stored scores as well as legacy rules so old generic-AI recommendations cannot leak through.
  return format === 'podcast' ? `(CASE WHEN ${microsoftRelevanceSql(alias)} THEN ${fit} ELSE 0 END)` : fit;
}
