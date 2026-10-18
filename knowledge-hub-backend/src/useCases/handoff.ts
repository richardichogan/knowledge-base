/**
 * useCases/handoff.ts — hands a use case's spec to whoever builds it:
 *  - github (default): publishes the spec note to a repo file and returns a prompt to
 *    paste into GitHub Copilot;
 *  - build: creates an Athena Build spec from the note.
 */
import type { Pool } from 'pg';
import { KnowledgeHubError, ValidationError } from '../types/errors.js';
import { IMAGINE_DEMO_BUILD_INSTRUCTION } from '../ai/imagineDemoBriefSkill.js';
import { getUseCase, recordAction, REPO_RE, slugify, type ProductKind, type UseCaseDetail } from './useCaseStore.js';

export type HandoffMode = 'github' | 'build';

export interface HandoffDeps {
  publish: (db: Pool, noteId: string, repo: string, path: string, message: string, expectedRevision: number) => Promise<{ url: string }>;
  createBuildSpec: (db: Pool, noteId: string, opts: { repo: string; title: string }) => Promise<{ id: string }>;
}

export interface HandoffResult { useCase: UseCaseDetail; mode: HandoffMode; url: string | null; path: string | null; buildSpecId: string | null; prompt: string | null }

const isImagine = (k: ProductKind): boolean => k !== 'product';

export function defaultHandoffPath(title: string, kind: ProductKind): string {
  return `${isImagine(kind) ? 'docs/prds' : 'docs/specs'}/${slugify(title)}.md`;
}

/** Pure: the prompt Richard pastes into GitHub Copilot once the spec file is in the repo. */
export function copilotPrompt(useCase: Pick<UseCaseDetail, 'title' | 'productKind'>, repo: string, path: string): string {
  if (isImagine(useCase.productKind)) {
    const what = useCase.productKind === 'imagine_demo' ? 'a new IMAGINE demo' : 'an update to the IMAGINE demo platform';
    return [
      `Implement ${what}: "${useCase.title}".`,
      `The demo brief is \`${path}\` in ${repo}. Read it first; treat anything marked "Not discussed yet" as an open decision to raise, not a gap to fill.`,
      '',
      IMAGINE_DEMO_BUILD_INSTRUCTION,
    ].join('\n');
  }
  return [
    `Implement "${useCase.title}" from the spec at \`${path}\` in ${repo}.`,
    'Read the whole spec first. Follow the repository\'s own instructions and patterns. Treat anything marked "Not discussed yet" or listed under Open questions as a decision to raise with me, not a gap to fill.',
    'Plan the work as small, reviewable steps; add or update tests for each; run the typecheck, lint and tests before you finish; and summarise what is done and what is still open.',
  ].join('\n');
}

function repoOf(v: unknown, fallback: string | null): string {
  const r = typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
  if (r === null) throw new ValidationError('Choose the repository to hand off to', { repo: 'required' });
  if (!REPO_RE.test(r)) throw new ValidationError('repo must be owner/name', { repo: 'expected owner/name' });
  return r;
}

export async function handoffUseCase(db: Pool, id: string, b: Record<string, unknown>, deps: HandoffDeps): Promise<HandoffResult> {
  const mode = b['mode'] === undefined ? 'github' : b['mode'];
  if (mode !== 'github' && mode !== 'build') throw new ValidationError('mode must be github or build', { mode: 'github, build' });
  const useCase = await getUseCase(db, id);
  const note = useCase.specNoteId === null ? undefined
    : (await db.query(`SELECT revision FROM notes WHERE id::text = $1 AND status = 'active'`, [useCase.specNoteId])).rows[0] as { revision: number } | undefined;
  if (useCase.specNoteId === null || note === undefined) {
    throw new KnowledgeHubError('Draft the spec first: this use case has no spec note to hand off.', 400, 'NO_SPEC_NOTE');
  }
  const repo = repoOf(b['repo'], useCase.handoffRepo ?? useCase.repo);

  if (mode === 'build') {
    const spec = await deps.createBuildSpec(db, useCase.specNoteId, { repo, title: useCase.title });
    const updated = await recordAction(db, id, { stage: 'handed_off', buildSpecId: spec.id });
    return { useCase: updated, mode, url: null, path: null, buildSpecId: spec.id, prompt: null };
  }

  const rawPath = typeof b['path'] === 'string' && b['path'].trim() !== '' ? b['path'].trim() : null;
  const path = rawPath ?? useCase.handoffPath ?? defaultHandoffPath(useCase.title, useCase.productKind);
  const published = await deps.publish(db, useCase.specNoteId, repo, path, `Add spec: ${useCase.title}`.slice(0, 200), Number(note.revision));
  const updated = await recordAction(db, id, { stage: 'handed_off', handoffRepo: repo, handoffPath: path, handoffUrl: published.url });
  return { useCase: updated, mode, url: published.url, path, buildSpecId: null, prompt: copilotPrompt(useCase, repo, path) };
}
