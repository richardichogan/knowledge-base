import type { Pool } from 'pg';
import { WORKFORCE_VERSION, type Assignment } from './contracts.js';
import { lockAssignment, workforceTransaction } from './store.js';

const NOTICE_KINDS = ['waiting', 'completed', 'failed', 'cancelled', 'superseded', 'budget-overrun'];
const NOTICE_BATCH = 10;

function message(assignment: Assignment, url: string | null): string {
  const link = url ? ` [Open the saved draft](${url}).` : '';
  if (assignment.status === 'completed') {
    return assignment.readiness === 'ready'
      ? `The blog team has completed the draft and independent review. It is ready for your review, not published.${link}`
      : `The blog team's review is complete, but the draft needs attention. Saved work has been retained; nothing was published by this assignment.${link}`;
  }
  if (assignment.status === 'waiting') return `The blog team has paused for attention. Saved work and the original allowance have been retained; no further work will start without an authorised resume.${link}`;
  if (assignment.status === 'cancelled') return `I cancelled the blog assignment and stopped future work. Saved drafts and reviews have been retained. Cancellation does not undo any separate delivery.${link}`;
  if (assignment.status === 'superseded') return `The blog assignment stopped because its controlling source or scope changed. Your changes and saved work have been retained; the old work was not automatically applied.${link}`;
  return `The blog team could not complete this assignment. Saved work has been retained; no unchecked output was accepted.${link}`;
}

/** The message, session timestamp and outbox receipt commit together; retries cannot duplicate a chat notice. */
async function deliverOne(db: Pool, pool: string): Promise<boolean> {
  return workforceTransaction(db, async client => {
    const candidate = await client.query<{ id: string; assignment_id: string }>(
      `SELECT e.id,e.assignment_id FROM agent_assignment_events e JOIN agent_assignments a ON a.id=e.assignment_id
        WHERE e.delivered_at IS NULL AND e.kind=ANY($2) AND a.worker_pool=$1
          AND a.workflow='manual-blog' AND a.workflow_version=$3
        ORDER BY e.created_at,e.id LIMIT 1`,
      [pool, NOTICE_KINDS, WORKFORCE_VERSION],
    );
    const selected = candidate.rows[0];
    if (!selected) return false;
    const assignment = await lockAssignment(client, selected.assignment_id);
    const event = await client.query<{ assignment_revision: number }>(
      `SELECT assignment_revision FROM agent_assignment_events
        WHERE id=$1 AND delivered_at IS NULL FOR UPDATE SKIP LOCKED`, [selected.id],
    );
    if (!event.rows[0]) return false;
    let delivery: { status: string; messageId?: string };
    if (event.rows[0].assignment_revision !== assignment.revision) {
      delivery = { status: 'superseded-before-delivery' };
    } else if (assignment.brief.origin.kind !== 'chat') {
      delivery = { status: 'not-a-chat-commission' };
    } else {
      const previous = await client.query<{ message_id: string }>(
        `SELECT metadata->'notice'->>'messageId' AS message_id FROM agent_assignment_events
          WHERE assignment_id=$1 AND assignment_revision=$2 AND metadata->'notice'->>'status'='delivered'
          ORDER BY created_at,id LIMIT 1`, [assignment.id, assignment.revision],
      );
      if (previous.rows[0]) {
        await client.query(
          `UPDATE agent_assignment_events SET delivered_at=clock_timestamp(),metadata=jsonb_set(metadata,'{notice}',$2::jsonb) WHERE id=$1`,
          [selected.id, JSON.stringify({ status: 'same-revision-already-delivered', messageId: previous.rows[0].message_id })],
        );
        return true;
      }
      const sessionId = assignment.brief.origin.conversationId;
      const sessions = await client.query('SELECT id FROM ai_chat_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      if (!sessions.rowCount) {
        console.warn('[workforce] Chat notice cannot be delivered because the conversation no longer exists:', assignment.id, selected.id);
        delivery = { status: 'conversation-unavailable' };
      } else {
        const draft = await client.query<{ id: string }>(
          `SELECT id FROM agent_jobs WHERE assignment_id=$1 AND (step_key='draft' OR input->>'workforceCanonicalBlog'='true')
            AND input->'blogCheckpoint'->'draft' IS NOT NULL ORDER BY created_at,id LIMIT 1`, [assignment.id],
        );
        const url = draft.rows[0] ? `?blogJob=${encodeURIComponent(draft.rows[0].id)}` : null;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ai_chat_messages(session_id,role,content,persona,workforce_event_id)
            VALUES($1,'assistant',$2,'general',$3) ON CONFLICT (workforce_event_id)
              WHERE workforce_event_id IS NOT NULL DO NOTHING RETURNING id::text`,
          [sessionId, message(assignment, url), selected.id],
        );
        const existing = inserted.rows[0] ? inserted : await client.query<{ id: string }>(
          'SELECT id::text FROM ai_chat_messages WHERE workforce_event_id=$1', [selected.id],
        );
        if (!existing.rows[0]) throw new Error('The assignment notice has no durable message receipt.');
        await client.query('UPDATE ai_chat_sessions SET updated_at=clock_timestamp() WHERE id=$1', [sessionId]);
        delivery = { status: 'delivered', messageId: existing.rows[0].id };
      }
    }
    await client.query(
      `UPDATE agent_assignment_events SET delivered_at=clock_timestamp(),metadata=jsonb_set(metadata,'{notice}',$2::jsonb)
        WHERE id=$1`, [selected.id, JSON.stringify(delivery)],
    );
    return true;
  });
}

export async function deliverAssignmentNotices(db: Pool, pool: string): Promise<void> {
  for (let count = 0; count < NOTICE_BATCH; count++) {
    if (!await deliverOne(db, pool)) return;
  }
}
