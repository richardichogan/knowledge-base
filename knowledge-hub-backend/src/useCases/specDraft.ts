/**
 * useCases/specDraft.ts — drafts a use case's spec from its sources (Discover items,
 * Sparks, notes, canvases) and product context, and saves it as a Think note.
 * Faithful to the sources: it records what they say and marks gaps; it invents nothing.
 */
import type { Pool } from 'pg';
import { ConflictError } from '../types/errors.js';
import { renderNoteAsText } from '../services/noteTextService.js';
import { diagramEvidence } from '../services/diagramContext.js';
import type { DiagramDocument } from '../types/diagram.js';
import { textToBlocks } from '../ai/markdownToNoteBlocks.js';
import { IMAGINE_DEMO_BRIEF_TEMPLATE } from '../ai/imagineDemoBriefSkill.js';
import { getUseCase, noteTitle, recordAction, type UseCaseDetail, type UseCaseSourceType } from './useCaseStore.js';

export const PER_SOURCE_CHARS = 8_000;
export const TOTAL_SOURCE_CHARS = 60_000;
const SPEC_MAX_TOKENS = 14_000;

export interface GatheredSource { sourceType: UseCaseSourceType; title: string; url: string | null; text: string }
export interface ProductContext { projectName: string | null; projectDescription: string; projectGoal: string; repo: string | null }

const SOURCE_LABEL: Record<UseCaseSourceType, string> = { discover: 'Discover item', spark: 'Spark', note: 'Think note', canvas: 'Canvas' };

const RULES = `Rules:
- Use ONLY what the sources and product context establish. Do not invent requirements, users, numbers, names, systems or decisions. Where something is not covered, write one line: _Not discussed yet._ — never fill a gap with a guess.
- Treat article claims as claims made by that article, not as facts about Richard's product.
- Keep the links the sources provide in a "Sources" section, as Markdown links.
- Be specific and concise: short paragraphs and bullets, no filler, no meta commentary.
- UK English. Return ONLY the Markdown.`;

const PRODUCT_SYSTEM = `You turn the material Richard has gathered for one use case into the FIRST DRAFT of a product spec that he will refine and then hand to a coding agent. Write Markdown.

${RULES}

Structure (keep these headings, in this order):
# <use case title>: spec
## Summary
Two or three sentences: what this is, and why it matters.
## Why it fits
How it relates to the product and project described.
## Users and their needs
## What it does
The capabilities, in plain terms. Add user stories ("As a …, I want …, so that …") only where the sources support them.
## Screens and flow
## Data and integrations
## Governance, risks and dependencies
## Decisions so far
## Open questions
## Next steps
## Sources`;

function imagineSystem(kind: 'imagine_demo' | 'imagine_platform'): string {
  return `You turn the material Richard has gathered for one IMAGINE use case into the FIRST DRAFT of an IMAGINE demo brief, which a coding agent will later build from. Write Markdown.

${RULES}
- The first line after the title must be exactly one of: "**Type:** New IMAGINE demo" or "**Type:** Update to the IMAGINE demo platform". This use case is marked as ${kind === 'imagine_demo' ? 'a new demo' : 'a platform update'}; use that unless the sources clearly say otherwise, and if they do, say so under Open questions.
- Follow the section structure of the template below, keeping its numbered headings. Fill tables only with what the sources support. Drop the template's instructions to the reader (such as "Copy this file into …") and replace its prompts with content or _Not discussed yet._
- Finish with "## Open questions" and "## Sources" sections after the template's sections.
- Start with "# <use case title>: spec".

Template:

${IMAGINE_DEMO_BRIEF_TEMPLATE}`;
}

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}\n[… truncated …]` : t);

/** Pure: the system and user messages for the draft. Sources are clipped per item and in total. */
export function buildSpecPrompt(useCase: Pick<UseCaseDetail, 'title' | 'summary' | 'productKind'>, product: ProductContext, sources: GatheredSource[]): { system: string; user: string } {
  const system = useCase.productKind === 'product' ? PRODUCT_SYSTEM : imagineSystem(useCase.productKind);
  const context = [
    `Use case: ${useCase.title}`,
    useCase.summary.trim() !== '' ? `Richard's summary: ${useCase.summary.trim()}` : '',
    `Kind: ${useCase.productKind === 'product' ? 'a product' : useCase.productKind === 'imagine_demo' ? 'a new IMAGINE demo' : 'an update to the IMAGINE demo platform'}`,
    product.projectName !== null ? `Project: ${product.projectName}` : '',
    product.projectDescription.trim() !== '' ? `Project description: ${product.projectDescription.trim()}` : '',
    product.projectGoal.trim() !== '' ? `Project goal: ${product.projectGoal.trim()}` : '',
    product.repo !== null ? `Repository: ${product.repo}` : '',
  ].filter(Boolean).join('\n');

  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const s of sources) {
    const header = `### ${SOURCE_LABEL[s.sourceType]}: ${s.title}${s.url !== null ? `\nLink: ${s.url}` : ''}`;
    const room = TOTAL_SOURCE_CHARS - used - header.length;
    if (room < 200) { omitted++; continue; }
    const body = clip(s.text.trim(), Math.min(PER_SOURCE_CHARS, room));
    const part = `${header}\n${body === '' ? '(no text)' : body}`;
    parts.push(part);
    used += part.length;
  }
  if (omitted > 0) parts.push(`[… ${omitted.toString()} more source${omitted === 1 ? '' : 's'} omitted for length …]`);

  const user = `${context}\n\n---\n\nSources (${sources.length.toString()}):\n\n${parts.length > 0 ? parts.join('\n\n') : '(none yet: draft from the use case and product context only, marking the rest _Not discussed yet._)'}`;
  return { system, user };
}

type Row = Record<string, unknown>;

async function canvasText(db: Pool, id: string): Promise<string> {
  const c = (await db.query('SELECT canvas_type FROM canvases WHERE id::text = $1 AND deleted_at IS NULL', [id])).rows[0] as Row | undefined;
  if (c === undefined) return '(this canvas is no longer available)';
  if (c['canvas_type'] === 'diagram') {
    const d = (await db.query('SELECT document FROM canvas_diagrams WHERE canvas_id::text = $1', [id])).rows[0] as Row | undefined;
    if (d === undefined) return '(empty diagram)';
    const doc = d['document'] as DiagramDocument;
    try {
      return `Diagram:\n${diagramEvidence(doc, PER_SOURCE_CHARS)}`;
    } catch {
      const labels = (Array.isArray(doc.nodes) ? doc.nodes : []).map((n) => n.label).filter((l) => typeof l === 'string' && l.trim() !== '');
      return labels.length > 0 ? `Diagram shapes:\n${labels.map((l) => `- ${l}`).join('\n')}` : '(empty diagram)';
    }
  }
  const { rows } = await db.query('SELECT label, body FROM canvas_nodes WHERE canvas_id::text = $1 ORDER BY y, x LIMIT 200', [id]);
  const lines = (rows as Row[]).map((n) => [n['label'], n['body']].filter((v) => typeof v === 'string' && v.trim() !== '').join(': ')).filter(Boolean);
  return lines.length > 0 ? `Brainstorm cards:\n${lines.map((l) => `- ${l}`).join('\n')}` : '(empty canvas)';
}

/** Reads each source's current text. Sources deleted since they were added are kept, marked unavailable. */
export async function gatherSources(db: Pool, useCase: UseCaseDetail): Promise<GatheredSource[]> {
  const out: GatheredSource[] = [];
  for (const s of useCase.sources) {
    let text = '';
    let title = s.title;
    if (s.sourceType === 'discover') {
      const r = (await db.query('SELECT title, summary, url FROM content_items WHERE id::text = $1', [s.sourceId])).rows[0] as Row | undefined;
      text = r === undefined ? '(this item is no longer available)' : String(r['summary'] ?? '');
    } else if (s.sourceType === 'spark') {
      const r = (await db.query('SELECT body FROM sparks WHERE id::text = $1', [s.sourceId])).rows[0] as Row | undefined;
      text = r === undefined ? '(this Spark is no longer available)' : String(r['body'] ?? '');
    } else if (s.sourceType === 'note') {
      const r = (await db.query(`SELECT content FROM notes WHERE id::text = $1 AND status = 'active'`, [s.sourceId])).rows[0] as Row | undefined;
      if (r === undefined) text = '(this note is no longer available)';
      else {
        const content = String(r['content'] ?? '');
        title = await noteTitle(db, content);
        text = await renderNoteAsText(db, content);
      }
    } else {
      text = await canvasText(db, s.sourceId);
    }
    out.push({ sourceType: s.sourceType, title, url: s.url, text });
  }
  return out;
}

async function productContext(db: Pool, useCase: UseCaseDetail): Promise<ProductContext> {
  let description = '';
  let goal = '';
  if (useCase.projectId !== null) {
    const r = (await db.query('SELECT description, goal FROM projects WHERE id = $1', [useCase.projectId])).rows[0] as Row | undefined;
    description = String(r?.['description'] ?? '');
    goal = String(r?.['goal'] ?? '');
  }
  return { projectName: useCase.projectName, projectDescription: description, projectGoal: goal, repo: useCase.repo };
}

export interface DraftDeps {
  generate: (system: string, user: string) => Promise<string>;
  createNote: (db: Pool, content: string, projectId: string | null) => Promise<string>;
  replaceNote: (db: Pool, noteId: string, writing: { title: string; contentType: string; contentJson: string }, expectedRevision: number) => Promise<void>;
}

/** Strips code fences and the leading H1 (the note keeps its title separately). */
export function cleanDraft(raw: string): string {
  return raw.trim().replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '').trim().replace(/^#\s+[^\n]*\n+/, '').trim();
}

export async function draftUseCaseSpec(db: Pool, id: string, opts: { replace: boolean }, deps: DraftDeps): Promise<{ useCase: UseCaseDetail; noteId: string; replaced: boolean }> {
  const useCase = await getUseCase(db, id);
  let existing: { id: string; revision: number } | null = null;
  if (useCase.specNoteId !== null) {
    const r = (await db.query(`SELECT id::text AS id, revision FROM notes WHERE id::text = $1 AND status = 'active'`, [useCase.specNoteId])).rows[0] as Row | undefined;
    if (r !== undefined) existing = { id: String(r['id']), revision: Number(r['revision']) };
  }
  if (existing !== null && !opts.replace) {
    throw new ConflictError('This use case already has a spec note. Open it, or redraft to replace it (the current text is kept in its history).', 'SPEC_EXISTS', { specNoteId: existing.id });
  }

  const sources = await gatherSources(db, useCase);
  const { system, user } = buildSpecPrompt(useCase, await productContext(db, useCase), sources);
  const markdown = cleanDraft(await deps.generate(system, user));
  const writing = { title: `${useCase.title}: spec`, contentType: 'note', contentJson: JSON.stringify(textToBlocks(markdown)) };

  let noteId: string;
  if (existing !== null) {
    await deps.replaceNote(db, existing.id, writing, existing.revision);
    noteId = existing.id;
  } else {
    noteId = await deps.createNote(db, JSON.stringify(writing), useCase.projectId);
  }
  const stage = useCase.stage === 'candidate' ? 'refining' : undefined;
  const updated = await recordAction(db, id, { specNoteId: noteId, ...(stage !== undefined ? { stage } : {}) });
  return { useCase: updated, noteId, replaced: existing !== null };
}

export const SPEC_DRAFT_LIMITS = { maxTokens: SPEC_MAX_TOKENS };
