import type { Pool } from 'pg';
import type { HealthFilters } from './knowledgeHealth.js';

export interface ReliabilityHealth {
  daily: Array<{ day: string; calls: number; failures: number; partialCalls: number }>;
  features: Array<{ feature: string; calls: number; failures: number; partialCalls: number }>;
}

export async function readReliability(db: Pool, filters: HealthFilters, start: string, end: string): Promise<ReliabilityHealth> {
  const where = `at>=$1::timestamptz AND at<$2::timestamptz AND environment=$3
    AND ($4::text IS NULL OR feature=$4) AND ($5::text IS NULL OR persona=$5) AND ($6::text IS NULL OR deployment=$6)`;
  const params = [start, end, filters.environment, filters.feature, filters.persona, filters.deployment];
  const daily = await db.query<ReliabilityHealth['daily'][number]>(`SELECT
    to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day",COUNT(*)::int calls,
    COUNT(*) FILTER(WHERE NOT ok AND failure_code IS DISTINCT FROM 'response-truncated')::int failures,
    COUNT(*) FILTER(WHERE failure_code='response-truncated')::int "partialCalls"
    FROM ai_usage_log WHERE ${where} GROUP BY "day" ORDER BY "day"`, params);
  const features = await db.query<ReliabilityHealth['features'][number]>(`SELECT
    feature,COUNT(*)::int calls,COUNT(*) FILTER(WHERE NOT ok AND failure_code IS DISTINCT FROM 'response-truncated')::int failures,
    COUNT(*) FILTER(WHERE failure_code='response-truncated')::int "partialCalls" FROM ai_usage_log
    WHERE ${where} GROUP BY feature ORDER BY failures DESC,calls DESC,feature LIMIT 10`, params);
  return { daily: daily.rows, features: features.rows };
}
