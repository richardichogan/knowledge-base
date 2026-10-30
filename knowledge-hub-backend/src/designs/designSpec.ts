/**
 * designs/designSpec.ts — Athena writes (or rewrites) a Design's spec from its use case.
 * An existing spec is updated in place with its previous text kept in note history;
 * a missing spec is created and linked to the Design.
 */
import type { Pool } from 'pg';
import { currentAgentAttempt, lockAgentAttempt } from '../agents/attempt.js';
import { createHash, randomUUID } from 'node:crypto';
import { getDesign } from './designStore.js';
import { lockSources, sourceSnapshot } from './designArtifacts.js';
import { LINK_TYPES, linkHref, type LinkType } from '../services/noteLinks.js';
import { parseWriting, writeNoteInTransaction } from '../services/noteVersionService.js';
import { textToBlocks } from '../ai/markdownToNoteBlocks.js';
import { getFoundryClient } from '../ai/foundryClient.js';
import { withAiWorkflow, withAiStage } from '../ai/aiWorkflow.js';
import { diagramEvidence } from '../services/diagramContext.js';
import type { DiagramDocument } from '../types/diagram.js';
import { PRODUCT_SYSTEM, cleanDraft } from '../useCases/specDraft.js';
import { AiError, ConflictError, ValidationError } from '../types/errors.js';
import type { Note } from '../types/index.js';
import { demoSpecificationForm, demoSpecificationResponseSchema, renderDemoSpecification, validateDemoSpecificationPart, DEMO_SPECIFICATION_VERSION, MAX_DEMO_SPECIFICATION_CHARS, type DemoSpecificationPart } from '../ai/demoSpecification.js';

const MAX_TOKENS = 16_000;
const IMAGINE_SECTION_TOKENS = 16_000;
const IMAGINE_SECTION_COUNT = 10;
const IMAGINE_GROUP_SIZE = 2;
const IMAGINE_SECTION_ATTEMPTS = 2;
const IMAGINE_SECTION_GROUPS = Array.from({ length: IMAGINE_SECTION_COUNT / IMAGINE_GROUP_SIZE },
  (_, index) => [index * IMAGINE_GROUP_SIZE + 1, (index + 1) * IMAGINE_GROUP_SIZE] as const);
const TIMEOUT_MS = 270_000;
const SOURCE_CHARS = MAX_DEMO_SPECIFICATION_CHARS;
const ARCHITECTURE_CHARS = 15_000;
const DIAGRAM_CHARS = 10_000;

const REWRITE = `You are regenerating an EXISTING spec from its use case. The use case is authoritative for what the feature must do and why.
- Keep the current spec's structure, section numbering, headings and level of detail wherever it is still consistent with the use case.
- Add everything the use case now requires that the spec lacks, in the section where it belongs.
- Never silently drop a settled decision, table, field list, limit or screen description. If the use case contradicts one, keep it and record the conflict under the spec's open questions.
- Remove only duplication and content that is plainly superseded by a later decision in the spec itself.
- Keep Markdown tables as tables. Start with "# <spec title>".
- Keep every link to another Athena record exactly as written ([Title](url)) in the section where it belongs.`;
const SELF_CONTAINED = `The specification must be usable without an unspecified earlier specification.
Include supplied permissions, data/fixture contracts, lifecycle transitions, failure behaviour and observable acceptance criteria in full.
Do not substitute "see the original specification" or a bare A01-A22 reference for requirements.
Retain source links as provenance, not as replacements for required content. If referenced content is unavailable,
identify precisely what cannot be established and why it blocks the build; never imply that it was supplied.
Technical proposals must be labelled Proposed, not confirmed business requirements. Never invent identities, approvals or observed results.
Keep prototype/simulation versus working live integrations explicit and preserve confirmed scope.
Specify business publication separately from agent deployment: snapshot content, destination, authorised publisher,
eligibility, stale/retry behaviour and receipt. Record unknown business decisions as blockers.`;
const IMAGINE_SYSTEM = `Write the complete IMAGINE demo specification using the supplied versioned form.
You are writing only the requested section group, not the whole specification.
Return JSON matching the schema: name, values for EVERY supplied field ID, additionalRows for EVERY supplied table ID (empty arrays where no extra rows are needed),
and detailed sectionDetails for the requested numbered sections. Every string must be a single line, without newline characters.
The server renders the original template; do not return Markdown instead.
Use all supplied source requirements, with enough scenario-specific detail to implement each behaviour. Do not summarise away fixture contracts or acceptance tests.
Use additionalRows for every required actor, digital worker, integration, workflow step and acceptance/traceability entry.
Use sectionDetails for detailed business rules, screen behaviour, data examples and lifecycle/edge cases that do not fit table cells.
Unknown facts must be explicit unresolved blockers, not invented data or blanket empty filler. Supplied synthetic fixtures remain synthetic.
Changing template does not authorise changing the delivery scope.
${SELF_CONTAINED}`;

interface SpecCheckpoint { db: Pool; jobId: string; designId: string; fingerprint: string }

function mergePart(target: DemoSpecificationPart, part: DemoSpecificationPart): void {
  if (!target.name) target.name = part.name;
  Object.assign(target.values, part.values);
  Object.assign(target.additionalRows, part.additionalRows);
  Object.assign(target.sectionDetails, part.sectionDetails);
}

async function requestImagineSection(user: string, completed: DemoSpecificationPart, section: number, progress: (message: string) => void, signal?: AbortSignal): Promise<DemoSpecificationPart> {
  const label = `IMAGINE section ${section}/10`;
  for (let attempt = 0; attempt < IMAGINE_SECTION_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    progress(`${attempt ? 'Retrying' : 'Writing'} ${label}`);
    let raw: string;
    try {
      raw = await withAiStage(`spec-section-${section}-attempt-${attempt + 1}`, () => getFoundryClient('use-case-spec').chatBulk([
        { role: 'system', content: IMAGINE_SYSTEM },
        { role: 'user', content: JSON.stringify({ sources: user, sections: [section], form: demoSpecificationForm([section]),
          completedSections: completed, instruction: 'Retain the established name, actors, record IDs and scope from completed sections. Complete only the requested fields.' }) },
      ], IMAGINE_SECTION_TOKENS, TIMEOUT_MS, 'medium', demoSpecificationResponseSchema([section]), signal));
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 0 && error instanceof AiError && error.message.includes('Bulk request timed out')) {
        progress(`${label} timed out; retrying this section only. Completed sections are retained.`);
        continue;
      }
      if (error instanceof AiError) throw new AiError(`${label} could not finish. The existing spec was not replaced. ${error.message}`);
      throw error;
    }
    signal?.throwIfAborted();
    try { return validateDemoSpecificationPart(JSON.parse(raw) as unknown, [section]); }
    catch (error) {
      throw new ValidationError(`${label} returned an incomplete or invalid response. The existing spec was not replaced. ${error instanceof Error ? error.message : 'Invalid section data.'}`);
    }
  }
  throw new ValidationError(`${label} did not complete. Nothing was saved.`);
}

async function imagineDraft(user: string, progress: (message: string) => void, signal?: AbortSignal, checkpoint?: SpecCheckpoint, checkpointOnly = false): Promise<DemoSpecificationPart> {
  const completed: DemoSpecificationPart = { name: '', values: {}, additionalRows: {}, sectionDetails: {} };
  const parts: DemoSpecificationPart[] = [];
  const sectionParts: Record<string, DemoSpecificationPart> = {};
  const persist = async (): Promise<void> => {
    if (!checkpoint) return;
    const attempt = currentAgentAttempt();
    if (!attempt || attempt.jobId !== checkpoint.jobId) throw new ConflictError('The specification checkpoint has no current worker owner.', 'AGENT_ATTEMPT_CONFLICT');
    signal?.throwIfAborted();
    const saved = await checkpoint.db.query(
      `UPDATE agent_jobs SET result=jsonb_build_object('specificationCheckpoint',$2::jsonb),updated_at=NOW()
        WHERE id=$1 AND subject_id=$3 AND specialist='spec-writer' AND status='running'
          AND attempts=$4 AND lease_owner=$5 AND lease_until>clock_timestamp() RETURNING id`,
      [checkpoint.jobId, JSON.stringify({ fingerprint: checkpoint.fingerprint, parts, sections: sectionParts }), checkpoint.designId, attempt.attempt, attempt.owner]);
    if (!saved.rows.length) throw new ConflictError('The Spec writer job stopped before its progress could be saved. The existing spec was not replaced.', 'DESIGN_CONFLICT');
  };
  if (checkpoint) {
    const row = (await checkpoint.db.query<{ checkpoint: unknown }>(
      `SELECT result->'specificationCheckpoint' AS checkpoint FROM agent_jobs
        WHERE specialist='spec-writer' AND subject_id=$1 AND result->'specificationCheckpoint'->>'fingerprint'=$2
        ORDER BY updated_at DESC LIMIT 1`, [checkpoint.designId, checkpoint.fingerprint])).rows[0];
    if (row) {
      const saved = row.checkpoint;
      if (!isObj(saved) || !Array.isArray(saved['parts']) || saved['parts'].length > IMAGINE_SECTION_GROUPS.length) {
        throw new ValidationError('The saved specification checkpoint is invalid. The existing spec was not replaced.');
      }
      for (const [index, part] of saved['parts'].entries()) {
        try { parts.push(validateDemoSpecificationPart(part, IMAGINE_SECTION_GROUPS[index]!)); }
        catch (error) { throw new ValidationError(`The saved specification checkpoint did not validate: ${error instanceof Error ? error.message : 'Invalid section data.'}`); }
      }
      if (saved['sections'] !== undefined) {
        if (!isObj(saved['sections'])) throw new ValidationError('The saved specification sections are invalid.');
        for (const [number, sectionPart] of Object.entries(saved['sections'])) {
          if (!/^(?:[1-9]|10)$/.test(number)) throw new ValidationError('The saved specification contains an unknown section.');
          try { sectionParts[number] = validateDemoSpecificationPart(sectionPart, [Number(number)]); }
          catch (error) { throw new ValidationError(`The saved specification section did not validate: ${error instanceof Error ? error.message : 'Invalid section data.'}`); }
        }
      }
    }
  }
  for (const [index, sections] of IMAGINE_SECTION_GROUPS.entries()) {
    signal?.throwIfAborted();
    const label = `IMAGINE sections ${sections.join('-')} (${index + 1}/${IMAGINE_SECTION_GROUPS.length})`;
    let part = parts[index];
    progress(`${part ? 'Reusing validated' : 'Writing'} ${label}`);
    if (!part) {
      if (checkpointOnly) throw new ValidationError('The complete saved specification no longer matches the current sources. No generation was started and nothing was saved.');
      part = { name: '', values: {}, additionalRows: {}, sectionDetails: {} };
      for (const section of sections) {
        const prior = { ...completed, values: { ...completed.values, ...part.values },
          additionalRows: { ...completed.additionalRows, ...part.additionalRows }, sectionDetails: { ...completed.sectionDetails, ...part.sectionDetails } };
        const sectionPart = sectionParts[String(section)] ?? await requestImagineSection(user, prior, section, progress, signal);
        sectionParts[String(section)] = sectionPart;
        mergePart(part, sectionPart);
        await persist();
        progress(`Validated IMAGINE section ${section}/10`);
      }
    }
    mergePart(completed, part);
    parts[index] = part;
    await persist();
    progress(`Validated ${label}`);
  }
  return completed;
}

type Inline = Record<string, unknown>;
const MEDIA = new Set(['image', 'video', 'audio', 'file']);
const isObj = (value: unknown): value is Inline => !!value && typeof value === 'object' && !Array.isArray(value);
const hasMedia = (value: unknown): boolean => Array.isArray(value) ? value.some(hasMedia)
  : isObj(value) && (MEDIA.has(String(value['type'])) || Object.values(value).some(hasMedia));

/** Note and record mentions in the current spec, keyed by the in-app link they export as. */
function mentionsOf(value: unknown, found = new Map<string, Inline>()): Map<string, Inline> {
  if (Array.isArray(value)) { for (const item of value) mentionsOf(item, found); return found; }
  if (!isObj(value)) return found;
  const props = isObj(value['props']) ? value['props'] : {};
  const type = value['type'] === 'noteMention' ? 'note' : value['type'] === 'entityMention' ? props['entityType'] : null;
  const id = value['type'] === 'noteMention' ? props['noteId'] : props['entityId'];
  if (typeof type === 'string' && LINK_TYPES.includes(type as LinkType) && typeof id === 'string') found.set(linkHref(type as LinkType, id), value);
  else for (const child of Object.values(value)) mentionsOf(child, found);
  return found;
}
const localHref = (href: string): string => { try { const url = new URL(href, 'http://athena.local'); return `${url.pathname}${url.search}`; } catch { return href; } };

/** Turns exported links back into native mentions; any mention Athena dropped is kept in a closing paragraph. */
function restoreMentions(blocks: unknown[], mentions: Map<string, Inline>): unknown[] {
  if (!mentions.size) return blocks;
  const used = new Set<string>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isObj(value)) return value;
    if (value['type'] === 'link' && typeof value['href'] === 'string') {
      const key = localHref(value['href']);
      const mention = mentions.get(key);
      if (mention) { used.add(key); return mention; }
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
  };
  const restored = walk(blocks) as unknown[];
  const missing = [...mentions].filter(([key]) => !used.has(key)).map(([, mention]) => mention);
  if (!missing.length) return restored;
  const content: unknown[] = [{ type: 'text', text: 'Related: ', styles: { bold: true } }];
  missing.forEach((mention, index) => { if (index) content.push({ type: 'text', text: ', ', styles: {} }); content.push(mention); });
  return [...restored, { type: 'paragraph', content }];
}

const sourceText = (text: string, limit: number): string => {
  if (text.length > limit) throw new ValidationError('A linked source exceeds the specification context limit. Nothing was truncated or saved; split the source before retrying.');
  return text;
};

export async function writeDesignSpec(db: Pool, designId: string, replace = false, signal?: AbortSignal, progress: (message: string) => void = () => {}, jobId?: string, checkpointOnly = false): Promise<{ noteId: string; title: string; created: boolean; notes: Note[]; publish: string[] }> {
  return withAiWorkflow(db, { feature: 'use-case-spec', ...(signal ? { signal } : {}) },
    () => writeDesignSpecInner(db, designId, replace, signal, progress, jobId, checkpointOnly));
}
async function writeDesignSpecInner(db: Pool, designId: string, replace: boolean, signal: AbortSignal | undefined, progress: (message: string) => void, jobId: string | undefined, checkpointOnly: boolean): Promise<{ noteId: string; title: string; created: boolean; notes: Note[]; publish: string[] }> {
  const design = await getDesign(db, designId);
  if (!design.specificationType) throw new ValidationError('Choose Standard or IMAGINE beside Generate spec in the Design before continuing.');
  const sources = await sourceSnapshot(db, design);
  const useCase = sources.find(source => source.role === 'use_case');
  if (!useCase?.markdown.trim()) throw new ValidationError('Link and write a use case before asking Athena for the spec.');
  const spec = sources.find(source => source.role === 'spec');
  if (spec && !replace && hasMedia(spec.blocks)) throw new ValidationError('The spec contains embedded images or files that a full rewrite would lose. Ask Athena in the chat for targeted changes instead.');
  const mentions = mentionsOf(spec?.blocks ?? []);
  const context = sources.filter(source => source.role === 'architecture' || source.role === 'diagram' || (source.role === 'design' && source.markdown.trim())).map(source => {
    if (source.role !== 'diagram') return `### ${source.role === 'design' ? 'Design' : 'Architecture'}: ${source.title}\n${sourceText(source.markdown, source.role === 'design' ? SOURCE_CHARS : ARCHITECTURE_CHARS)}`;
    try { return `### Diagram: ${source.title}\n${diagramEvidence(source.document as DiagramDocument, DIAGRAM_CHARS)}`; } catch { return ''; }
  }).filter(Boolean);
  const title = spec?.title ?? `Spec: ${design.title}`;
  const system = design.specificationType === 'imagine' ? IMAGINE_SYSTEM : `${PRODUCT_SYSTEM}\n\n${SELF_CONTAINED}${spec ? `\n\n${REWRITE}` : ''}`;
  const user = [`Design: ${design.title}`, design.summary.trim() ? `Summary: ${design.summary.trim()}` : '',
    `## Use case (authoritative): ${useCase.title}\n${sourceText(useCase.markdown, SOURCE_CHARS)}`,
    spec ? `## Current spec: ${spec.title} (revision ${String(spec.revision)})\n${sourceText(spec.markdown, SOURCE_CHARS)}` : '',
    context.length ? `## Supporting context\n${context.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
  const imagine = design.specificationType === 'imagine';
  let markdown: string;
  if (imagine) {
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: DEMO_SPECIFICATION_VERSION,
      groups: IMAGINE_SECTION_GROUPS, designRevision: design.revision, sources })).digest('hex');
    const input = await imagineDraft(user, progress, signal, jobId ? { db, jobId, designId: design.id, fingerprint } : undefined, checkpointOnly);
    progress('Validating the complete IMAGINE specification');
    try {
      markdown = renderDemoSpecification({ ...input, templateVersion: DEMO_SPECIFICATION_VERSION }, {
        noteUrl: `/think?noteId=${useCase.id}`, designUrl: `/think?design=${design.id}`,
      }).markdown;
    } catch (error) {
      throw new ValidationError(`The complete IMAGINE specification did not validate. Nothing was saved. ${error instanceof Error ? error.message : 'Invalid specification.'}`);
    }
  } else {
    if (checkpointOnly) throw new ValidationError('Only an unchanged, complete IMAGINE checkpoint can be finalized without generation.');
    progress('Writing the Standard product specification');
    markdown = cleanDraft(await getFoundryClient('use-case-spec').chatBulk(
      [{ role: 'system', content: system }, { role: 'user', content: user }], MAX_TOKENS, TIMEOUT_MS, 'medium', undefined, signal));
  }
  const blocks = restoreMentions(textToBlocks(markdown), mentions);
  if (!blocks.length) throw new ValidationError('Athena returned an empty spec. Nothing was saved; retry.');
  signal?.throwIfAborted();
  progress('Saving the validated specification and preserving the previous version');

  const noteId = spec?.id ?? randomUUID();
  const client = await db.connect();
  const notes: Note[] = [];
  const publish: string[] = [];
  try {
    await client.query('BEGIN');
    await lockAgentAttempt(client);
    const locked = (await client.query<{ revision: number }>('SELECT revision FROM designs WHERE id=$1 FOR UPDATE', [design.id])).rows[0];
    if (locked?.revision !== design.revision) throw new ConflictError('The Design links changed while Athena was writing. Nothing was saved; retry.', 'DESIGN_CONFLICT');
    await lockSources(client, sources);
    if (spec) {
      const row = (await client.query<{ content: string; revision: number }>("SELECT content,revision FROM notes WHERE id=$1 AND status='active' FOR UPDATE", [spec.id])).rows[0];
      if (row?.revision !== spec.revision) throw new ConflictError('The spec was edited while Athena was writing. Nothing was saved; retry.', 'DESIGN_CONFLICT');
      const result = await writeNoteInTransaction(client, spec.id, { expectedRevision: spec.revision, protectBefore: true,
        content: JSON.stringify({ ...JSON.parse(row.content) as object, title: parseWriting(row.content).title, contentJson: JSON.stringify(blocks) }) });
      notes.push(result.note); if (result.publish) publish.push(spec.id);
    } else {
      await client.query('INSERT INTO notes(id,content,project_id) VALUES($1,$2,$3)',
        [noteId, JSON.stringify({ title, contentType: 'spec', contentJson: JSON.stringify(blocks) }), design.projectId]);
      notes.push((await writeNoteInTransaction(client, noteId, { expectedRevision: 0 })).note);
      await client.query(`INSERT INTO design_assets(design_id,source_type,source_id,role,excluded) VALUES($1,'note',$2,'spec',false)
        ON CONFLICT(design_id,source_type,source_id) DO UPDATE SET role=EXCLUDED.role,excluded=false`, [design.id, noteId]);
      await client.query(`UPDATE designs SET selections=jsonb_set(selections,'{spec}',to_jsonb($2::text)),revision=revision+1,updated_at=NOW() WHERE id=$1`, [design.id, noteId]);
    }
    await lockAgentAttempt(client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { noteId, title, created: !spec, notes, publish };
}
