import type { Pool } from 'pg';
import { env } from '../config/env.js';

export interface DiagramReceipt {
  tool: string; targetId: string; revision: number; warnings: string[];
}
export interface DiagramActionEvidence { saved: boolean; queued: boolean; receipts?: DiagramReceipt[] }

export function diagramReceipt(name: string, value: unknown): DiagramReceipt | null {
  if (!['create_diagram', 'update_diagram', 'apply_diagram_candidate'].includes(name)
    || !value || typeof value !== 'object' || 'error' in value || !('success' in value) || value.success !== true
    || !('diagram' in value) || !value.diagram || typeof value.diagram !== 'object') return null;
  const diagram = value.diagram;
  if (!('id' in diagram) || typeof diagram.id !== 'string'
    || !('revision' in diagram) || typeof diagram.revision !== 'number' || !Number.isSafeInteger(diagram.revision) || diagram.revision < 0) return null;
  return { tool: name, targetId: diagram.id, revision: diagram.revision,
    warnings: 'problems' in value && Array.isArray(value.problems) ? value.problems.filter((v): v is string => typeof v === 'string') : [] };
}

export function recordDiagramAction(evidence: DiagramActionEvidence, name: string, result: unknown, specialist?: unknown): void {
  if (!result || typeof result !== 'object' || 'error' in result) return;
  const receipt = diagramReceipt(name, result);
  if (receipt) {
    evidence.saved = true;
    (evidence.receipts ??= []).push(receipt);
  }
  if (name === 'hand_off_to_specialist' && specialist === 'daedalus' && 'status' in result
    && (result.status === 'started' || result.status === 'already_running')) evidence.queued = true;
}

export async function previousDiagramReceipt(db: Pool, sessionId: string | undefined, targetId: string | undefined): Promise<DiagramReceipt | null> {
  if (!sessionId || !targetId) return null;
  const { rows } = await db.query<{ name: string; content: string; current_revision: number }>(`SELECT
    e.payload->>'name' AS name,e.payload->>'content' AS content,d.revision AS current_revision
    FROM ai_turn_traces t JOIN ai_turn_trace_events e ON e.trace_id=t.id
    JOIN canvas_diagrams d ON d.canvas_id=$2::uuid
    JOIN canvases c ON c.id=d.canvas_id AND c.deleted_at IS NULL
    WHERE t.session_id=$1::uuid AND t.expires_at>NOW() AND t.status<>'running'
      AND t.environment=$3 AND e.kind='tool.result'
      AND e.payload->>'name' IN ('create_diagram','update_diagram','apply_diagram_candidate')
    ORDER BY t.started_at DESC,e.sequence DESC LIMIT 10`, [sessionId, targetId, env.isDevelopment ? 'dev' : 'prod']);
  for (const row of rows) {
    const receipt = diagramReceipt(row.name, JSON.parse(row.content));
    if (receipt?.targetId === targetId) return receipt.revision === row.current_revision ? receipt : null;
  }
  return null;
}

export function deniesDiagramSave(reply: string): boolean {
  return /\bI\s+(?:have\s+not|haven['’]t|did\s+not|didn['’]t)\s+(?:actually\s+)?(?:done\s+it|(?:saved|changed|updated|redrawn|modified)\b[^.!?\n]{0,80}\b(?:diagram|canvas))\b/i.test(reply);
}

export function deniesEditingCapability(reply: string): boolean {
  return /\b(?:I\s+(?:can['’]t|cannot|do\s+not\s+have|don['’]t\s+have)\b[^.!?\n]{0,100}\b(?:edit|mutate|modify|write\s+tool)|(?:edit(?:ing)?|write|mutation)\s+(?:tool|capability)\b[^.!?\n]{0,65}\b(?:unavailable|not\s+available))\b/i.test(reply);
}

export function unconfirmedDiagramClaim(reply: string, evidence: DiagramActionEvidence): boolean {
  if (evidence.saved) return false;
  return /\b(?:I(?:'ve|’ve| have)?\s+(?:(?:now|successfully)\s+)?(?:redrawn|drawn|recreated|re-created|rebuilt)|I(?:'ve|’ve| have)?\s+(?:(?:now|successfully)\s+)?(?:updated|changed|renamed|saved|applied)\b[^.!?\n]{0,100}\b(?:diagram|canvas|drawing)|(?:the|your|saved)\s+diagram\s+(?:has\s+been|is\s+now)\s+(?:redrawn|updated|saved|changed|renamed|rebuilt))\b/i.test(reply);
}
