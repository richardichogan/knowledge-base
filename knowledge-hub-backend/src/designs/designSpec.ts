/**
 * designs/designSpec.ts — Athena writes (or rewrites) a Design's spec from its use case.
 * An existing spec is updated in place with its previous text kept in note history;
 * a missing spec is created and linked to the Design.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { getDesign } from './designStore.js';
import { lockSources, sourceSnapshot } from './designArtifacts.js';
import { LINK_TYPES, linkHref, type LinkType } from '../services/noteLinks.js';
import { parseWriting, writeNoteInTransaction } from '../services/noteVersionService.js';
import { textToBlocks } from '../ai/markdownToNoteBlocks.js';
import { getFoundryClient } from '../ai/foundryClient.js';
import { diagramEvidence } from '../services/diagramContext.js';
import type { DiagramDocument } from '../types/diagram.js';
import { PRODUCT_SYSTEM, cleanDraft } from '../useCases/specDraft.js';
import { ConflictError, ValidationError } from '../types/errors.js';
import type { Note } from '../types/index.js';

const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 270_000;
const SOURCE_CHARS = 60_000;
const ARCHITECTURE_CHARS = 15_000;
const DIAGRAM_CHARS = 10_000;

const REWRITE = `You are regenerating an EXISTING spec from its use case. The use case is authoritative for what the feature must do and why.
- Keep the current spec's structure, section numbering, headings and level of detail wherever it is still consistent with the use case.
- Add everything the use case now requires that the spec lacks, in the section where it belongs.
- Never silently drop a settled decision, table, field list, limit or screen description. If the use case contradicts one, keep it and record the conflict under the spec's open questions.
- Remove only duplication and content that is plainly superseded by a later decision in the spec itself.
- Keep Markdown tables as tables. Start with "# <spec title>".
- Keep every link to another Athena record exactly as written ([Title](url)) in the section where it belongs.`;

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

const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}\n[… truncated …]` : text;

export async function writeDesignSpec(db: Pool, designId: string, replace = false, signal?: AbortSignal): Promise<{ noteId: string; title: string; created: boolean; notes: Note[]; publish: string[] }> {
  const design = await getDesign(db, designId);
  const sources = await sourceSnapshot(db, design);
  const useCase = sources.find(source => source.role === 'use_case');
  if (!useCase?.markdown.trim()) throw new ValidationError('Link and write a use case before asking Athena for the spec.');
  const spec = sources.find(source => source.role === 'spec');
  if (spec && !replace && hasMedia(spec.blocks)) throw new ValidationError('The spec contains embedded images or files that a full rewrite would lose. Ask Athena in the chat for targeted changes instead.');
  const mentions = mentionsOf(spec?.blocks ?? []);
  const context = sources.filter(source => source.role === 'architecture' || source.role === 'diagram').map(source => {
    if (source.role !== 'diagram') return `### Architecture: ${source.title}\n${clip(source.markdown, ARCHITECTURE_CHARS)}`;
    try { return `### Diagram: ${source.title}\n${diagramEvidence(source.document as DiagramDocument, DIAGRAM_CHARS)}`; } catch { return ''; }
  }).filter(Boolean);
  const title = spec?.title ?? `Spec: ${design.title}`;
  const system = `${PRODUCT_SYSTEM}${spec ? `\n\n${REWRITE}` : ''}`;
  const user = [`Design: ${design.title}`, design.summary.trim() ? `Summary: ${design.summary.trim()}` : '',
    `## Use case (authoritative): ${useCase.title}\n${clip(useCase.markdown, SOURCE_CHARS)}`,
    spec ? `## Current spec: ${spec.title} (revision ${String(spec.revision)})\n${clip(spec.markdown, SOURCE_CHARS)}` : '',
    context.length ? `## Supporting context\n${context.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
  const markdown = cleanDraft(await getFoundryClient('use-case-spec').chatBulk(
    [{ role: 'system', content: system }, { role: 'user', content: user }], MAX_TOKENS, TIMEOUT_MS, 'medium'));
  const blocks = restoreMentions(textToBlocks(markdown), mentions);
  if (!blocks.length) throw new ValidationError('Athena returned an empty spec. Nothing was saved; retry.');
  signal?.throwIfAborted();

  const noteId = spec?.id ?? randomUUID();
  const client = await db.connect();
  const notes: Note[] = [];
  const publish: string[] = [];
  try {
    await client.query('BEGIN');
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
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { noteId, title, created: !spec, notes, publish };
}
