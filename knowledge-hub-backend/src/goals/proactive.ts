/**
 * goals/proactive.ts — one read model and one action dispatcher for Phase 2/3 proactive Athena
 * (deal desk, meeting prep, promises, chases, cadence, content packages, CFP shortlist, self-report).
 * Today's routes and Athena's manage_proactive tool both go through here, so they share every service and rule.
 */
import type { Pool } from 'pg';
import { ValidationError } from '../types/errors.js';
import type { TaskActivityActor } from '../work/taskEditActivity.js';
import { dealDeskHistory, dealDeskRunning, dealDeskStatus, runDealDesk, undoDealUpdate, updateDealFromNotes } from './dealDesk.js';
import { decideCadence, decidePromise, dismissChase, getMeetingPrep, meetingPrepRunning, refreshMeetingPrep } from './meetingPrep.js';
import { dismissPackage, listPackages, runContentPackages } from './contentPackages.js';
import { cfpShortlist, decideCfp } from './cfpShortlist.js';
import { proposalReport, proposalType, setProposalTypeEnabled } from './proposals.js';

export async function proactiveOverview(db: Pool) {
  const [deals, prep, packages, cfps, ledger] = await Promise.all([
    dealDeskStatus(db), getMeetingPrep(db), listPackages(db), cfpShortlist(db), proposalReport(db)]);
  return {
    deals: { rows: deals, running: dealDeskRunning() },
    meetingPrep: { ...prep, running: meetingPrepRunning() },
    packages: packages.packages, cfps, ledger,
  };
}
export type ProactiveOverview = Awaited<ReturnType<typeof proactiveOverview>>;

export const PROACTIVE_ACTIONS = [
  'run-deal-desk', 'update-deal-from-notes', 'deal-history', 'undo-deal-update',
  'refresh-meeting-prep', 'accept-promise', 'dismiss-promise', 'accept-cadence', 'dismiss-cadence', 'dismiss-chase',
  'run-content-package', 'dismiss-package', 'confirm-cfp', 'dismiss-cfp', 'enable-proposal-type', 'disable-proposal-type',
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
    case 'dismiss-chase': return dismissChase(db, args.id);
    case 'run-content-package': {
      const itemId = typeof args.itemId === 'string' && args.itemId.trim() ? args.itemId.trim() : undefined;
      void runContentPackages(db, trigger, itemId).catch(log('Content package')); return { started: true };
    }
    case 'dismiss-package': await dismissPackage(db, str(args.id, 'the package id'), actor); return { dismissed: true };
    case 'confirm-cfp': return decideCfp(db, str(args.id, 'the CFP id'), true, actor);
    case 'dismiss-cfp': return decideCfp(db, str(args.id, 'the CFP id'), false, actor);
    case 'enable-proposal-type': await setProposalTypeEnabled(db, proposalType(args.type), true); return proposalReport(db);
    case 'disable-proposal-type': await setProposalTypeEnabled(db, proposalType(args.type), false); return proposalReport(db);
    default: throw new ValidationError(`Unknown proactive action. Use one of: ${PROACTIVE_ACTIONS.join(', ')}.`);
  }
}
