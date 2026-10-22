/** Capability report so a graph/semantic connection alone is never shown as healthy. */
import type { Pool } from 'pg';
import { parseMonitoringConfig } from './monitoring.js';

export interface SemanticStatus {
  schemaReady: boolean;
  decisions: { total: number; acceptanceUnknown: number; withReviewDate: number };
  edges: { total: number; inferred: number };
  monitoring: { enabled: boolean; reason?: string };
}

export async function getSemanticStatus(db: Pool, monitoringConfig: unknown): Promise<SemanticStatus> {
  const monitoring = parseMonitoringConfig(monitoringConfig);
  const monitoringStatus = monitoring.enabled ? { enabled: true } : { enabled: false, reason: monitoring.reason };
  try {
    const d = await db.query<Record<string, string>>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE accepted_at IS NULL OR acceptance_origin IS DISTINCT FROM 'user_confirmed') AS unknown,
              COUNT(*) FILTER (WHERE review_date IS NOT NULL) AS reviewed FROM chat_decisions`);
    const e = await db.query<Record<string, string>>(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE origin = 'inferred') AS inferred FROM semantic_edges`);
    return {
      schemaReady: true,
      decisions: { total: Number(d.rows[0]?.['total']), acceptanceUnknown: Number(d.rows[0]?.['unknown']), withReviewDate: Number(d.rows[0]?.['reviewed']) },
      edges: { total: Number(e.rows[0]?.['total']), inferred: Number(e.rows[0]?.['inferred']) }, monitoring: monitoringStatus,
    };
  } catch {
    return { schemaReady: false, decisions: { total: 0, acceptanceUnknown: 0, withReviewDate: 0 }, edges: { total: 0, inferred: 0 }, monitoring: monitoringStatus };
  }
}
