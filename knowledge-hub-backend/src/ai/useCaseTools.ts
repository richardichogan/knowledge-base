import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { getUseCase, parsePatch, updateUseCase } from '../useCases/useCaseStore.js';
import type { UseCaseDetail } from '../useCases/useCaseStore.js';
import { ConflictError, ValidationError } from '../types/errors.js';

const MAX_USE_CASE_READ_CHARS = 24_000;
const MAX_USE_CASE_SOURCES = 100;
const MAX_USE_CASE_LINKS = 100;

export interface UseCaseTurnState {
  read?: { id: string; summary: string; updatedAt: string };
  changed: boolean;
}

export const USE_CASE_WRITE_TOOLS = ['update_use_case'];
export const USE_CASE_TOOL_NAMES = new Set(['read_use_case', ...USE_CASE_WRITE_TOOLS]);

export const USE_CASE_CHAT_TOOLS: LlmToolDefinition[] = [
  { type: 'function', function: {
    name: 'read_use_case',
    description: 'Read the selected Think use case’s complete structured record, including summary, stage, product/workstream/repository settings, exact source identities and links, and linked Design/spec/Build identifiers. Read before editing. If the full record exceeds the bounded read limit, the tool refuses the read instead of silently truncating it.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  } },
  { type: 'function', function: {
    name: 'update_use_case',
    description: 'Save an explicitly requested change to the selected use case’s summary only. First call read_use_case. Supply the exact expectedSummary returned by that read; the normal Use Case patch parser and atomic summary conflict check are used. This does not change stage, sources, links, Design documents, handoff, Build state or execution.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      summary: { type: 'string', maxLength: 4000 },
      expectedSummary: { type: 'string', maxLength: 4000 },
    }, required: ['summary', 'expectedSummary'] },
  } },
];

export async function executeUseCaseTool(db: Pool, name: string, args: Record<string, unknown>, access: {
  selectedUseCaseId?: string; strictProjectId?: string | null; retrievalFiltered?: boolean;
  excludedIds?: ReadonlySet<string>; readOnly?: boolean;
}, state: UseCaseTurnState): Promise<unknown> {
  const id = access.selectedUseCaseId;
  if (!id) throw new ValidationError('Open a Think use case before using its tools.');
  if (access.retrievalFiltered) throw new ValidationError('Use case tools do not support the enforced collection filter.', { code: 'scope_mismatch' });
  if (access.excludedIds?.has(id)) throw new ValidationError('The selected use case is excluded from this conversation.');
  const counts = (await db.query<{ sources: number; links: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM use_case_sources WHERE use_case_id::text = $1) AS sources,
       (SELECT COUNT(*)::int FROM use_case_links WHERE use_case_id::text = $1) AS links`,
    [id],
  )).rows[0];
  if ((counts?.sources ?? 0) > MAX_USE_CASE_SOURCES || (counts?.links ?? 0) > MAX_USE_CASE_LINKS) {
    throw new ValidationError('The complete use case record exceeds the bounded read limit. No partial record was supplied.');
  }
  const useCase: UseCaseDetail = await getUseCase(db, id);
  if (access.strictProjectId && useCase.projectId !== access.strictProjectId) {
    throw new ValidationError('The selected use case is outside the enforced workstream scope.');
  }
  if (useCase.sources.some(source => access.excludedIds?.has(source.sourceId))) {
    throw new ValidationError('A source linked to the selected use case is excluded from this conversation.');
  }
  if (name === 'read_use_case') {
    if (JSON.stringify(useCase).length > MAX_USE_CASE_READ_CHARS) {
      throw new ValidationError('The complete use case record exceeds the bounded read limit. No partial record was supplied.');
    }
    state.read = { id, summary: useCase.summary, updatedAt: useCase.updatedAt };
    return {
      ...useCase,
      instructions: 'This is the actual saved use case with its sources and links. Source identities are references, not proof their full source content was read. Use update_use_case only for an explicitly requested summary edit.',
    };
  }
  if (name === 'update_use_case') {
    if (access.readOnly) throw new ValidationError('This turn is read-only.');
    if (!state.read || state.read.id !== id || state.read.summary !== args['expectedSummary']
      || state.read.updatedAt !== useCase.updatedAt) {
      throw new ConflictError('Read the current use case before saving; the selected summary changed.', 'USE_CASE_REVIEW_CONFLICT');
    }
    const saved = await updateUseCase(db, id, parsePatch({
      summary: args['summary'], expectedSummary: args['expectedSummary'],
    }));
    state.changed = true;
    state.read = { id, summary: saved.summary, updatedAt: saved.updatedAt };
    return {
      saved: true, useCaseId: id, summary: saved.summary, updatedAt: saved.updatedAt,
      url: `/think?useCase=${encodeURIComponent(id)}`,
      instructions: 'The summary was saved to the selected Think use case. No stage, source, link, Design, Build or handoff state changed.',
    };
  }
  throw new ValidationError('Unknown use case operation.');
}
