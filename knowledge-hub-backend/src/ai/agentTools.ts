/**
 * ai/agentTools.ts — Athena hands work to specialist agents and checks on it.
 *
 * Generic over every registered specialist: the job runs in the background,
 * Athena carries on, and the outcome is posted back into this chat.
 */
import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { getAgentJob, handOff, listAgentJobs, listSpecialists, getSpecialist, workerPool, type AgentJob } from '../agents/index.js';
import { KnowledgeHubError } from '../types/errors.js';
import { getAssignmentSummary, listAssignmentSummaries } from '../agents/workforce/status.js';
import { hasManualBlogExecutor } from '../agents/workforce/dispatcher.js';
import { startChatManualBlogCommission, type TrustedChatBlogAction } from '../agents/workforce/blogCommission.js';
import { applyDiagramCandidate, captureDiagramRequest, type DiagramAccess } from '../services/diagramCandidates.js';
import type { RetrievalScope } from './knowledge/retrievalScope.js';

export interface AgentToolContext extends TrustedChatBlogAction {
  designOwner?: string | undefined;
  noteId?: string | undefined;
  retrievalScope?: RetrievalScope | undefined;
}

export const AGENT_TOOL_NAMES = new Set(['hand_off_to_specialist', 'check_specialist_jobs', 'check_workforce_assignments', 'apply_diagram_candidate']);
const RECENT_JOBS = 5;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function agentToolDefinitions(): LlmToolDefinition[] {
  const specialists = listSpecialists();
  return [
    {
      type: 'function',
      function: {
        name: 'hand_off_to_specialist',
        description: `Hands a long piece of work to a specialist agent that runs in the background. You do not wait: say it has started and that you will report back in this chat when it finishes, then carry on with anything else. Specialists:\n${specialists.map((s) => `- ${s.id} (${s.name}, works on a ${s.subjectType}): ${s.description}`).join('\n')}\nIf the result is needs_confirmation, explain the plan and what it replaces, ask him, and call again with confirmed true only after he agrees.`,
        parameters: {
          type: 'object',
          properties: {
            specialist: { type: 'string', enum: specialists.map((s) => s.id) },
            subjectId: { type: 'string', description: 'ID of what to work on. Omit to use the open Design/diagram. For a new Ariadne diagram use new:<current-chat-session-UUID>.' },
            instruction: { type: 'string', description: 'Optional direction for the specialist, e.g. what the Blueprint should emphasise.' },
            length: { type: 'string', enum: ['short', 'long'], description: 'For the blog writer: short is Quick take, long is Article. Ask which before starting.' },
            revision: { type: 'integer', minimum: 0, description: 'Exact current diagram revision from read_diagram for Ariadne, or episode revision from read_podcast_script. Never guess or reuse an earlier revision.' },
            referenceDiagramIds: { type: 'array', maxItems: 3, items: { type: 'string' }, description: 'Ariadne: selected saved diagrams to use as layout examples, not business content. Otherwise suitable permitted examples are retrieved.' },
            screenIds: { type: 'array', maxItems: 2, items: { type: 'string' }, description: 'Ariadne: reference screenshot IDs from this chat’s Screens context. The specialist receives the actual images.' },
            confirmed: { type: 'boolean', description: 'He agreed to a plan that replaces existing work.' },
          },
          required: ['specialist'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_diagram_candidate',
        description: 'Apply a completed Ariadne candidate to its original diagram only after the user explicitly approves that replacement. Read both current revisions first. If the original changed since generation, generate a fresh candidate instead. Keeps a recovery snapshot and the separate candidate.',
        parameters: {
          type: 'object', additionalProperties: false,
          properties: {
            jobId: { type: 'string' }, revision: { type: 'integer', minimum: 0 },
            candidateRevision: { type: 'integer', minimum: 0 }, confirmed: { type: 'boolean' },
          },
          required: ['jobId', 'revision', 'candidateRevision', 'confirmed'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_workforce_assignments',
        description: 'Read Athena-owned workforce progress, current named specialist/stage, saved-result link and attention state for the authenticated owner. Does not commission, resume, cancel, edit or publish anything.',
        parameters: { type: 'object', additionalProperties: false, properties: { assignmentId: { type: 'string', description: 'Exact assignment ID, or omit to list recent assignments.' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_specialist_jobs',
        description: 'Checks specialist jobs: one job by ID, or recent jobs on a subject (defaults to the open Design). Use when he asks how a handoff is going.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            subjectId: { type: 'string', description: 'Omit in a Design conversation to use the open Design.' },
          },
        },
      },
    },
  ];
}

const brief = (job: AgentJob): Record<string, unknown> => ({
  jobId: job.id, specialist: job.specialistName, subject: job.subjectTitle, link: job.subjectUrl || undefined, status: job.status,
  latestProgress: job.progress.at(-1), summary: job.summary ?? undefined, error: job.error ?? undefined,
  prerequisiteStep: job.isStep || undefined, startedAt: job.startedAt ?? undefined, finishedAt: job.finishedAt ?? undefined,
  ...(job.specialist === 'daedalus' && job.status === 'done' ? { result: job.result } : {}),
});

export async function executeAgentTool(
  db: Pool,
  name: string,
  args: Record<string, unknown>,
  turn: AgentToolContext,
): Promise<unknown> {
  const subjectArg = typeof args['subjectId'] === 'string' && args['subjectId'].trim() ? args['subjectId'].trim() : undefined;
  const diagramAccess: DiagramAccess = {
    userId: turn.userId, sessionId: turn.sessionId, excludedIds: turn.excludedIds, exclusionsFailed: turn.exclusionsFailed,
    strictProjectId: turn.strictProjectId, readOnly: turn.readOnly,
    scopeFiltered: turn.retrievalScope !== undefined && Object.keys(turn.retrievalScope.filter).length > 0,
  };
  try {
    if (name === 'apply_diagram_candidate') return await applyDiagramCandidate(db, args, diagramAccess);
    if (name === 'check_workforce_assignments') {
      if (!turn.userId) return { error: 'Authenticated owner identity is required to read workforce assignments.' };
      const id = typeof args['assignmentId'] === 'string' ? args['assignmentId'].trim() : '';
      if (id && !UUID.test(id)) return { error: 'A valid workforce assignment ID is required.' };
      return id ? { assignment: await getAssignmentSummary(db, id, turn.userId) }
        : { assignments: await listAssignmentSummaries(db, turn.userId) };
    }
    if (name === 'check_specialist_jobs') {
      const jobId = typeof args['jobId'] === 'string' ? args['jobId'].trim() : '';
      if (jobId) {
        if (!UUID.test(jobId)) return { error: 'That is not a specialist job ID.' };
        return brief(await getAgentJob(db, jobId, turn.userId));
      }
      const subjectId = subjectArg ?? (turn.noteId?.startsWith('map:') ? turn.noteId.slice('map:'.length) : turn.designOwner);
      if (!subjectId) return { error: 'Give a jobId or subjectId, or open the Design.' };
      const ids = new Set([subjectId]);
      for (const specialist of listSpecialists()) {
        try { ids.add((await specialist.resolveSubject(db, subjectId)).id); } catch { /* not this specialist's kind of subject */ }
      }
      const jobs = (await Promise.all([...ids].map((id) => listAgentJobs(db, { subjectId: id, limit: RECENT_JOBS }))))
        .flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_JOBS);
      return jobs.length ? { jobs: jobs.map(brief) } : { jobs: [], note: 'No specialist has worked on this yet.' };
    }

    const specialistId = typeof args['specialist'] === 'string' ? args['specialist'] : '';
    const specialist = getSpecialist(specialistId);
    if (!specialist) return { error: `Unknown specialist. Choose one of: ${listSpecialists().map((s) => s.id).join(', ')}.` };
    if (specialist.id === 'script-visual-designer') return { error: 'Use design_script_visuals for script visuals; it validates access and captures the saved source before queuing Ariadne.' };
    const subjectId = subjectArg ?? (specialist.subjectType === 'design' ? turn.designOwner
      : specialist.id === 'daedalus' ? turn.noteId?.replace(/^map:/, '') : undefined);
    if (!subjectId) return { error: `Say which ${specialist.subjectType} ${specialist.name} should work on.` };
    const instruction = typeof args['instruction'] === 'string' && args['instruction'].trim() ? args['instruction'].trim() : undefined;
    const diagramInput = specialist.id === 'daedalus'
      ? await captureDiagramRequest(db, subjectId, args, diagramAccess, turn.userMessage ?? '') : undefined;
    if (specialist.id === 'blog-writer' && hasManualBlogExecutor()) {
      const commissioned = await startChatManualBlogCommission(db, workerPool(), { subjectId, length: args['length'], instruction }, turn);
      return {
        status: commissioned.existing ? 'already_running' : 'started',
        assignment: await getAssignmentSummary(db, commissioned.assignment.id, commissioned.assignment.brief.ownerId),
        note: 'Athena commissioned Iris, Calliope and Momus in the background. The independent review and any attention state will be reported in this chat. Publication remains a separate action.',
      };
    }
    const result = await handOff(db, {
      specialist: specialist.id,
      subjectId,
      input: diagramInput ?? { ...(instruction ? { instruction } : {}), ...(typeof args['length'] === 'string' ? { length: args['length'] } : {}),
        ...(args['revision'] !== undefined ? { revision: args['revision'] } : {}) },
      conversationId: turn.sessionId ?? null,
      requestedBy: 'chat',
      confirmed: args['confirmed'] === true,
    });
    if (result.status === 'needs_confirmation') {
      return { status: 'needs_confirmation', plan: result.plan.map((step) => `${step.specialistName}: ${step.reason}`), message: result.message };
    }
    if (result.status === 'already_running') {
      return { status: 'already_running', job: brief(result.job), note: 'This was already handed off; it will report back when it finishes.' };
    }
    return {
      status: 'started',
      job: brief(result.job),
      steps: result.steps.map(brief),
      note: turn.sessionId ? 'Running in the background. The outcome will be posted in this chat and shown as a notice.' : 'Running in the background. The outcome will be shown as a notice.',
    };
  } catch (error) {
    if (error instanceof KnowledgeHubError) return { error: error.message };
    console.error('[agents] Chat handoff failed:', error);
    return { error: 'The handoff could not be confirmed. Check Background work before retrying.' };
  }
}
