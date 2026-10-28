/**
 * ai/agentTools.ts — Athena hands work to specialist agents and checks on it.
 *
 * Generic over every registered specialist: the job runs in the background,
 * Athena carries on, and the outcome is posted back into this chat.
 */
import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { getAgentJob, handOff, listAgentJobs, listSpecialists, getSpecialist, type AgentJob } from '../agents/index.js';
import { KnowledgeHubError } from '../types/errors.js';

export const AGENT_TOOL_NAMES = new Set(['hand_off_to_specialist', 'check_specialist_jobs']);
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
            subjectId: { type: 'string', description: 'ID of what to work on. Omit in a Design conversation to use the open Design.' },
            instruction: { type: 'string', description: 'Optional direction for the specialist, e.g. what the Blueprint should emphasise.' },
            length: { type: 'string', enum: ['short', 'long'], description: 'For the blog writer: short is Quick take, long is Article. Ask which before starting.' },
            confirmed: { type: 'boolean', description: 'He agreed to a plan that replaces existing work.' },
          },
          required: ['specialist'],
        },
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
});

export async function executeAgentTool(
  db: Pool,
  name: string,
  args: Record<string, unknown>,
  turn: { sessionId?: string | undefined; designOwner?: string | undefined },
): Promise<unknown> {
  const subjectArg = typeof args['subjectId'] === 'string' && args['subjectId'].trim() ? args['subjectId'].trim() : undefined;
  try {
    if (name === 'check_specialist_jobs') {
      const jobId = typeof args['jobId'] === 'string' ? args['jobId'].trim() : '';
      if (jobId) {
        if (!UUID.test(jobId)) return { error: 'That is not a specialist job ID.' };
        return brief(await getAgentJob(db, jobId));
      }
      const subjectId = subjectArg ?? turn.designOwner;
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
    const subjectId = subjectArg ?? (specialist.subjectType === 'design' ? turn.designOwner : undefined);
    if (!subjectId) return { error: `Say which ${specialist.subjectType} ${specialist.name} should work on.` };
    const instruction = typeof args['instruction'] === 'string' && args['instruction'].trim() ? args['instruction'].trim() : undefined;
    const result = await handOff(db, {
      specialist: specialist.id,
      subjectId,
      input: { ...(instruction ? { instruction } : {}), ...(typeof args['length'] === 'string' ? { length: args['length'] } : {}) },
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
    return { error: 'The handoff failed. Nothing was started.' };
  }
}
