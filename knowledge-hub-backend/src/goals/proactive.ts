/**
 * goals/proactive.ts — one read model and one action dispatcher for Phase 2/3 proactive Athena
 * (deal desk, meeting prep, promises, chases, cadence, CFP shortlist, self-report).
 * Today's routes and Athena's manage_proactive tool both go through here, so they share every service and rule.
 */
import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import type { TaskActivityActor } from '../work/taskEditActivity.js';
import { createDealDraft, dealDeskHistory, dealDeskRunning, dealDeskStatus, dealNoteId, runDealDesk, setDealStage, undoDealUpdate, updateDealFromNotes } from './dealDesk.js';
import { acceptChase, decideCadence, decidePromise, dismissChase, getMeetingPrep, meetingPrepRunning, refreshMeetingPrep } from './meetingPrep.js';
import { cfpShortlist, decideCfp } from './cfpShortlist.js';
import { gateProposals, proposalReport, proposalType, setProposalTypeEnabled } from './proposals.js';
import { loopPauses, resolvePause } from './loopBreaker.js';
import { handOff } from '../agents/engine.js';
import { resumeJob } from '../jobs/store.js';

export async function proactiveOverview(db: Pool) {
  const [deals, prep, cfps, ledger, paused] = await Promise.all([
    dealDeskStatus(db), getMeetingPrep(db), cfpShortlist(db), proposalReport(db), loopPauses(db)]);
  // Peak timing: open proposals surface Mon–Fri 9–11 and 16–18 (UK), three at a time. Held items stay readable by Athena.
  const candidates = [
    ...prep.promises.filter(x => x.status === 'proposed').map(x => `promise:${x.id}`),
    ...prep.chases.filter(x => x.status === 'proposed').map(x => `chase:${x.id}`),
    ...prep.cadence.filter(x => x.status === 'proposed').map(x => `cadence:${x.id}`),
    ...cfps.shortlist.map(x => `cfp:${x.id}`),
  ];
  const gate = await gateProposals(db, candidates);
  const held = (id: string) => candidates.includes(id) && !gate.visible.has(id);
  return {
    paused,
    timing: { peak: gate.peak, held: gate.held, nextWindow: gate.nextWindow },
    deals: { rows: deals, running: dealDeskRunning() },
    meetingPrep: { ...prep, running: meetingPrepRunning(),
      promises: prep.promises.map(x => ({ ...x, held: held(`promise:${x.id}`) })),
      chases: prep.chases.map(x => ({ ...x, held: held(`chase:${x.id}`) })),
      cadence: prep.cadence.map(x => ({ ...x, held: held(`cadence:${x.id}`) })) },
    cfps: { ...cfps, shortlist: cfps.shortlist.map(x => ({ ...x, held: held(`cfp:${x.id}`) })) },
    ledger,
  };
}
export type ProactiveOverview = Awaited<ReturnType<typeof proactiveOverview>>;

export const PROACTIVE_ACTIONS = [
  'run-deal-desk', 'update-deal-from-notes', 'deal-history', 'undo-deal-update', 'create-deal-draft', 'set-deal-stage',
  'refresh-meeting-prep', 'accept-promise', 'dismiss-promise', 'accept-cadence', 'dismiss-cadence', 'accept-chase', 'dismiss-chase',
  'confirm-cfp', 'dismiss-cfp', 'enable-proposal-type', 'disable-proposal-type',
  'resume-paused', 'stop-paused',
] as const;
export type ProactiveAction = typeof PROACTIVE_ACTIONS[number];

const log = (label: string) => (error: unknown) => { console.error(`[Proactive] ${label} failed:`, error instanceof Error ? error.message : error); };
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`Provide ${name}.`);
  return v.trim();
};

/** Long runs start in the background (`started: true`); the caller re-reads the overview. Decisions complete inline. */
export async function proactiveAction(db: Pool, action: unknown, args: Record<string, unknown>, actor: TaskActivityActor): Promise<unknown> {
  const trigger = actor === 'athena' ? 'athena' : 'manual';
  switch (action as ProactiveAction) {
    case 'run-deal-desk': void runDealDesk(db, trigger).catch(log('Deal desk')); return { started: true };
    case 'update-deal-from-notes': return updateDealFromNotes(db, args.projectId, args.notes);
    case 'deal-history': return dealDeskHistory(db, args.projectId);
    case 'undo-deal-update': return undoDealUpdate(db, args.updateId ?? args.id);
    case 'refresh-meeting-prep': void refreshMeetingPrep(db, trigger).catch(log('Meeting prep')); return { started: true };
    case 'accept-promise': return decidePromise(db, args.id, true, actor);
    case 'dismiss-promise': return decidePromise(db, args.id, false, actor);
    case 'accept-cadence': return decideCadence(db, args.id, true, actor);
    case 'dismiss-cadence': return decideCadence(db, args.id, false, actor);
    case 'accept-chase': return acceptChase(db, args.id);
    case 'dismiss-chase': return dismissChase(db, args.id);
    case 'create-deal-draft': return createDealDraft(db, args.updateId ?? args.id);
    case 'set-deal-stage': return setDealStage(db, await dealNoteId(db, args), args.stage);
    case 'confirm-cfp': return decideCfp(db, str(args.id, 'the CFP id'), true, actor);
    case 'dismiss-cfp': return decideCfp(db, str(args.id, 'the CFP id'), false, actor);
    case 'enable-proposal-type': await setProposalTypeEnabled(db, proposalType(args.type), true); return proposalReport(db);
    case 'disable-proposal-type': await setProposalTypeEnabled(db, proposalType(args.type), false); return proposalReport(db);
    case 'resume-paused': return resumePaused(db, args.key ?? args.id);
    case 'stop-paused': return resolvePause(db, args.key ?? args.id, 'stopped');
    default: throw new ValidationError(`Unknown proactive action. Use one of: ${PROACTIVE_ACTIONS.join(', ')}.`);
  }
}

/** "Try again": clears the failure count and, for a specialist, re-queues its last failed request; for a job, re-enables it. */
async function resumePaused(db: Pool, key: unknown): Promise<unknown> {
  const pause = await resolvePause(db, key, 'resumed');
  if (pause.kind === 'job' && pause.jobId) { await resumeJob(db, pause.jobId, 'richard'); return { resumed: pause.key }; }
  if (!pause.specialist || !pause.subjectId) return { resumed: pause.key };
  const last = await db.query<{ input: Record<string, unknown> }>(
    `SELECT input FROM agent_jobs WHERE specialist=$1 AND subject_type=$2 AND subject_id=$3 AND status='failed' ORDER BY created_at DESC LIMIT 1`,
    [pause.specialist, pause.subjectType, pause.subjectId]);
  const result = await handOff(db, { specialist: pause.specialist, subjectId: pause.subjectId, input: last.rows[0]?.input ?? {}, requestedBy: 'app', confirmed: true });
  return { resumed: pause.key, handOff: result.status };
}
