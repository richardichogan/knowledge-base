import type { Pool } from 'pg';
import { getExcludedSources } from '../../ai/contextUsage.js';
import { KnowledgeValidationError } from '../../types/knowledge.js';
import { readKnowledgeRecord } from './reader.js';

/** Tools that can surface source content and therefore must fail closed when exclusions are unknown. */
export const EXCLUSION_GATED_TOOLS: ReadonlySet<string> = new Set([
  'search_knowledge_base', 'search_library', 'find_files', 'read_knowledge_record', 'read_diagram',
  'search_diagrams', 'search_knowledge_graph', 'search_past_chats', 'read_past_chat',
]);

export const EXCLUSIONS_UNAVAILABLE_RESULT = {
  status: 'unavailable', code: 'exclusions_unavailable', retryable: true,
  message: 'Source exclusions could not be verified, so no source was read. Try again shortly.',
} as const;

export interface KnowledgeToolTurn {
  sessionId?: string | undefined;
  excludedIds?: ReadonlySet<string> | undefined;
  strictProjectId?: string | null | undefined;
}

/** Tool entry point: validates model arguments, revalidates exclusions per call, maps typed errors. */
export async function executeReadKnowledgeRecord(db: Pool, args: Record<string, unknown>, turn: KnowledgeToolTurn): Promise<unknown> {
  const sessionId = turn.sessionId ?? 'no-session';
  const loadExcluded = async (): Promise<Set<string>> => {
    const ids = new Set(turn.excludedIds ?? []);
    if (turn.sessionId !== undefined) for (const s of await getExcludedSources(db, turn.sessionId)) ids.add(s.id);
    return ids;
  };
  try {
    return await readKnowledgeRecord(db, {
      kind: args['kind'] as string,
      id: args['id'] as string,
      ...(args['cursor'] !== undefined ? { cursor: args['cursor'] as string } : {}),
      ...(args['offset'] !== undefined ? { offset: args['offset'] as number } : {}),
      ...(args['maxChars'] !== undefined ? { maxChars: args['maxChars'] as number } : {}),
      ...(args['outputVersion'] !== undefined ? { outputVersion: args['outputVersion'] as number } : {}),
    }, { sessionId, strictProjectId: turn.strictProjectId ?? null, loadExcluded });
  } catch (err) {
    if (err instanceof KnowledgeValidationError) return { status: 'invalid_request', code: err.code, error: err.message };
    throw err;
  }
}
