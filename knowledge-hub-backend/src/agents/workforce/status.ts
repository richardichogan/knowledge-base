import type { Pool } from 'pg';
import { NotFoundError, ValidationError } from '../../types/errors.js';
import {
  MANUAL_BLOG_STEPS, WORKFORCE_ROLES, WORKFORCE_VERSION, parseAssignmentBrief, type AssignmentState, type Readiness, type RoleId,
} from './contracts.js';

export interface AssignmentSummary {
  id: string;
  subjectType: string;
  subjectId: string;
  title: string;
  status: AssignmentState;
  readiness: Readiness;
  revision: number;
  reason: string | null;
  currentStep: { key: string; role: RoleId; name: string; title: string; profile: string } | null;
  resultUrl: string | null;
  callsUsed: string;
  tokensUsed: string;
  deadline: string;
  createdAt: string;
  finishedAt: string | null;
}

interface SummaryRow {
  id: string;
  brief: unknown;
  status: AssignmentState;
  readiness: Readiness;
  revision: number;
  reason: string | null;
  subject_title: string | null;
  step_key: string | null;
  role_id: string | null;
  task_profile: string | null;
  draft_job_id: string | null;
  calls_reserved: string;
  tokens_reserved: string;
  deadline: Date;
  created_at: Date;
  finished_at: Date | null;
}

const SUMMARY_SQL = `SELECT a.id,a.brief,a.status,a.readiness,a.revision,a.reason,
    a.calls_reserved::text,a.tokens_reserved::text,a.deadline,a.created_at,a.finished_at,
    j.subject_title,j.step_key,j.role_id,j.task_profile,d.id AS draft_job_id
  FROM agent_assignments a
  LEFT JOIN LATERAL (
    SELECT subject_title,step_key,role_id,task_profile FROM agent_jobs WHERE assignment_id=a.id
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1
  ) j ON TRUE
  LEFT JOIN LATERAL (
    SELECT id FROM agent_jobs WHERE assignment_id=a.id AND (step_key='draft' OR input->>'workforceCanonicalBlog'='true')
      AND input->'blogCheckpoint'->'draft' IS NOT NULL ORDER BY created_at,id LIMIT 1
  ) d ON TRUE
  WHERE a.owner_id=$1 AND a.workflow='manual-blog' AND a.workflow_version=$2`;

const MAX_LIST = 50;

export interface AssignmentNotice {
  eventId: string;
  conversationId: string | null;
  assignment: AssignmentSummary;
}

export async function listAssignmentNotices(db: Pool, ownerId: string): Promise<AssignmentNotice[]> {
  const result = await db.query<SummaryRow & { event_id: string }>(
    `SELECT s.*,e.id AS event_id FROM (${SUMMARY_SQL}) s JOIN LATERAL (
      SELECT id,acknowledged_at FROM agent_assignment_events WHERE assignment_id=s.id AND assignment_revision=s.revision
        AND kind IN ('completed','waiting','failed','cancelled','superseded','budget-overrun')
        AND created_at>clock_timestamp()-INTERVAL '1 day' ORDER BY created_at DESC,id DESC LIMIT 1
      ) e ON TRUE WHERE e.acknowledged_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM agent_assignment_events acknowledged WHERE acknowledged.assignment_id=s.id
          AND acknowledged.assignment_revision=s.revision AND acknowledged.acknowledged_at IS NOT NULL)
        AND (s.brief->'origin'->>'kind'<>'chat'
        OR EXISTS(SELECT 1 FROM agent_assignment_events delivered WHERE delivered.id=e.id AND delivered.delivered_at IS NOT NULL))
      ORDER BY s.created_at DESC,s.id LIMIT $3`,
    [ownerId, WORKFORCE_VERSION, MAX_LIST],
  );
  return result.rows.map(row => {
    const brief = parseAssignmentBrief(row.brief);
    return { eventId: row.event_id, conversationId: brief.origin.kind === 'chat' ? brief.origin.conversationId : null, assignment: summary(row) };
  });
}

export async function acknowledgeAssignmentNotice(db: Pool, eventId: string, ownerId: string): Promise<void> {
  const result = await db.query(
    `UPDATE agent_assignment_events e SET acknowledged_at=COALESCE(e.acknowledged_at,clock_timestamp())
      FROM agent_assignments a WHERE a.id=e.assignment_id AND a.owner_id=$2 AND e.id=$1 RETURNING e.id`,
    [eventId, ownerId],
  );
  if (!result.rowCount) throw new NotFoundError('Workforce notice');
}

function summary(row: SummaryRow): AssignmentSummary {
  const brief = parseAssignmentBrief(row.brief);
  const role = row.role_id === null ? null : WORKFORCE_ROLES.find(role => role.id === row.role_id);
  const definition = Object.values(MANUAL_BLOG_STEPS).find(step => step.key === row.step_key);
  if (row.role_id !== null && (!role || definition?.role !== role.id || definition.profile !== row.task_profile)) {
    throw new ValidationError('The assignment has invalid worker metadata. No status has been invented.');
  }
  return {
    id: row.id, subjectType: brief.subjectType, subjectId: brief.subjectId, title: row.subject_title ?? brief.subjectId,
    status: row.status, readiness: row.readiness, revision: row.revision, reason: row.reason,
    currentStep: role && row.step_key && row.task_profile ? {
      key: row.step_key, role: role.id, name: role.name, title: role.title, profile: row.task_profile,
    } : null,
    resultUrl: row.draft_job_id ? `?blogJob=${encodeURIComponent(row.draft_job_id)}` : null,
    callsUsed: row.calls_reserved, tokensUsed: row.tokens_reserved, deadline: row.deadline.toISOString(),
    createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export async function listAssignmentSummaries(db: Pool, ownerId: string): Promise<AssignmentSummary[]> {
  const result = await db.query<SummaryRow>(
    `${SUMMARY_SQL} AND (a.status IN ('queued','running','waiting') OR a.finished_at>clock_timestamp()-INTERVAL '1 day')
      ORDER BY a.created_at DESC,a.id LIMIT $3`,
    [ownerId, WORKFORCE_VERSION, MAX_LIST],
  );
  return result.rows.map(summary);
}

export async function getAssignmentSummary(db: Pool, id: string, ownerId: string): Promise<AssignmentSummary> {
  const result = await db.query<SummaryRow>(`${SUMMARY_SQL} AND a.id=$3`, [ownerId, WORKFORCE_VERSION, id]);
  if (!result.rows[0]) throw new NotFoundError('Workforce assignment');
  return summary(result.rows[0]);
}
