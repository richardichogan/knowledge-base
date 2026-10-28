/**
 * agents/registry.ts — the specialists Athena can hand work to.
 *
 * A specialist is registered once: what it works on, what it does and which
 * other specialists must finish first. The job engine, live updates, notices
 * and Athena's handoff tools work for every registered specialist, so adding a
 * new one (a direct model call, a Foundry agent or a worker service such as a
 * Microsoft Agent Framework app) needs no changes anywhere else.
 */
import type { Pool } from 'pg';

/** What a running specialist can do: report progress and check for shutdown. */
export interface SpecialistContext {
  db: Pool;
  jobId: string;
  attempt: number;
  subjectId: string;
  input: Record<string, unknown>;
  progress: (message: string) => void;
  signal: AbortSignal;
}

/** A job this specialist needs finished first, e.g. the Blueprint designer needs a current spec. */
export interface Prerequisite {
  specialist: string;
  input: Record<string, unknown>;
  /** Plain-language reason, shown to the user before anything is overwritten. */
  reason: string;
  /** True when the prerequisite rewrites existing work, so the user must confirm the plan. */
  overwrites: boolean;
}

export interface SpecialistResult {
  /** Saved for Athena and the UI, e.g. the IDs of what was written. */
  data: Record<string, unknown>;
  /** One sentence for the job notice and Athena's follow-up message. */
  summary: string;
}

export interface Specialist {
  id: string;
  name: string;
  /** One line telling Athena when to hand off to this specialist. */
  description: string;
  subjectType: string;
  /** Resolves the subject to its canonical ID, title and app link; throws if it does not exist. */
  resolveSubject: (db: Pool, subjectId: string) => Promise<{ id: string; title: string; url: string }>;
  /** Normalises the job's input; throws ValidationError for bad input. */
  parseInput?: (input: Record<string, unknown>) => Record<string, unknown>;
  /** Jobs that must run first. Evaluated at handoff time. */
  prerequisites?: (db: Pool, subjectId: string, input: Record<string, unknown>) => Promise<Prerequisite[]>;
  /** Rewrites existing work, so the user must confirm before it starts. */
  overwrites?: (db: Pool, subjectId: string, input: Record<string, unknown>) => Promise<boolean>;
  run: (context: SpecialistContext) => Promise<SpecialistResult>;
}

const specialists = new Map<string, Specialist>();

export function registerSpecialist(specialist: Specialist): void {
  if (specialists.has(specialist.id)) throw new Error(`Specialist ${specialist.id} is already registered.`);
  specialists.set(specialist.id, specialist);
}

export function getSpecialist(id: string): Specialist | undefined {
  return specialists.get(id);
}

export function listSpecialists(): Specialist[] {
  return [...specialists.values()];
}
