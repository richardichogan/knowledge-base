/**
 * useCases/handoff.ts — hands a use case's spec to whoever builds it:
 *  - github (default): publishes the spec note to a repo file and returns a prompt to
 *    paste into GitHub Copilot;
 *  - build: creates an Athena Build spec from the note.
 */
import type { Pool } from 'pg';
import { HTTP_STATUS } from '../config/constants.js';
import { KnowledgeHubError, ValidationError } from '../types/errors.js';
import { IMAGINE_DEMO_BUILD_INSTRUCTION } from '../ai/imagineDemoBriefSkill.js';
import { getUseCase, recordAction, REPO_RE, slugify, type ProductKind, type UseCaseDetail } from './useCaseStore.js';
import { parseWriting, writeNote } from '../services/noteVersionService.js';
import { validatePublicationPath } from '../services/noteGitHubService.js';
import { HANDOFF_CONTRACT } from '../build/handoffContract.js';

export type HandoffMode = 'github' | 'build';

export interface HandoffDeps {
  publish: (db: Pool, noteId: string, repo: string, path: string, message: string, expectedRevision: number) => Promise<{ url: string }>;
  createBuildSpec: (db: Pool, noteId: string, opts: { repo: string; title: string }) => Promise<{ id: string }>;
}

export interface HandoffResult { useCase: UseCaseDetail; mode: HandoffMode; url: string | null; path: string | null; buildSpecId: string | null; prompt: string | null }

const MAX_COMMIT_MESSAGE = 200;
const MAX_VISUAL_LINKS = 8;
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
      HANDOFF_CONTRACT,
      '',
      IMAGINE_DEMO_BUILD_INSTRUCTION,
    ].join('\n');
  }
  return [
    `Implement "${useCase.title}" from the spec at \`${path}\` in ${repo}.`,
    HANDOFF_CONTRACT,
    'Read the whole spec first. Follow the repository\'s own instructions and patterns. Treat anything marked "Not discussed yet" or listed under Open questions as a decision to raise with me, not a gap to fill.',
    'Plan the work as small, reviewable steps; add or update tests for each; run the typecheck, lint and tests before you finish; and summarise what is done and what is still open.',
  ].join('\n');
}

export function selectedVisualLinks(useCase: Pick<UseCaseDetail, 'links'>, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_VISUAL_LINKS || raw.some(value => typeof value !== 'string')) {
    throw new ValidationError('Select up to eight supporting visual links.');
  }
  return [...new Set(raw as string[])].map(id => {
    const link = useCase.links.find(value => value.id === id);
    if (!link) throw new ValidationError('A selected visual link is no longer attached to this use case.');
    let url: URL;
    try { url = new URL(link.url); } catch { throw new ValidationError('A selected supporting visual has an invalid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new ValidationError('Supporting visual links must be HTTP(S) URLs without credentials.');
    }
    return url.href;
  });
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
    : (await db.query(`SELECT revision, content FROM notes WHERE id::text = $1 AND status = 'active'`, [useCase.specNoteId])).rows[0] as { revision: number; content: string } | undefined;
  if (useCase.specNoteId === null || note === undefined) {
    throw new KnowledgeHubError('Draft the spec first: this use case has no spec note to hand off.', HTTP_STATUS.BAD_REQUEST, 'NO_SPEC_NOTE');
  }
  const repo = repoOf(b['repo'], useCase.handoffRepo ?? useCase.repo);
  const rawPath = typeof b['path'] === 'string' && b['path'].trim() !== '' ? b['path'].trim() : null;
  const path = mode === 'github' ? validatePublicationPath(rawPath ?? useCase.handoffPath ?? defaultHandoffPath(useCase.title, useCase.productKind)) : null;
  const visuals = selectedVisualLinks(useCase, b['visualLinkIds']);
  if (visuals.length) {
    const writing = parseWriting(note.content);
    const blocks = JSON.parse(writing.contentJson) as unknown[];
    // Only append references not already present; repeat handoffs don't duplicate them.
    const missing = visuals.filter(url => !writing.contentJson.includes(JSON.stringify(url).slice(1, -1)));
    if (missing.length) {
      const updated = await writeNote(db, useCase.specNoteId, {
        expectedRevision: Number(note.revision),
        restoreWriting: { ...writing, contentJson: JSON.stringify([...blocks,
          { type: 'heading', props: { level: 2 }, content: 'Supporting visual references (non-authoritative)' },
          { type: 'paragraph', content: HANDOFF_CONTRACT },
          ...missing.map(url => ({ type: 'bulletListItem', content: [{ type: 'link', href: url,
            content: [{ type: 'text', text: url, styles: {} }] }] })),
        ]) },
      });
      if (updated.revision === undefined) throw new ValidationError('The spec revision is unavailable after adding references. Reload the note before handing it off.');
      note.revision = updated.revision;
    }
  }

  if (mode === 'build') {
    const spec = await deps.createBuildSpec(db, useCase.specNoteId, { repo, title: useCase.title });
    const updated = await recordAction(db, id, { stage: 'handed_off', buildSpecId: spec.id });
    return { useCase: updated, mode, url: null, path: null, buildSpecId: spec.id, prompt: null };
  }

  if (path === null) throw new ValidationError('Choose a Markdown path for GitHub handoff.');
  const published = await deps.publish(db, useCase.specNoteId, repo, path, `Add spec: ${useCase.title}`.slice(0, MAX_COMMIT_MESSAGE), Number(note.revision));
  const updated = await recordAction(db, id, { stage: 'handed_off', handoffRepo: repo, handoffPath: path, handoffUrl: published.url });
  return { useCase: updated, mode, url: published.url, path, buildSpecId: null, prompt: copilotPrompt(useCase, repo, path) };
}
