import type { Pool } from 'pg';
import { downloadBlobAsText } from '../integrations/cms/blobClient.js';
import { env } from '../config/env.js';
import { retrieveRagItems, formatRagContext } from './ragRetriever.js';
import type { AiContext, ConversationMessage } from '../types/aiContext.js';

const STATIC_CONTEXT_BLOB = 'config/static-context.md';
const PROJECT_CONTEXT_BLOB = 'config/project-context.md';

/**
 * Builds the three-layer AI context for a conversation turn.
 *
 * Layer 1 — Static context: user prefs, code standards, identity rules.
 *            Loaded from blob storage. Updated occasionally.
 * Layer 2 — Project context: architecture decisions, active project state.
 *            Loaded fresh on each session open.
 * Layer 3 — Dynamic RAG context: top-N relevant items from PostgreSQL FTS
 *            retrieved per turn based on the user query.
 */
export async function buildAiContext(db: Pool, userQuery: string): Promise<AiContext> {
  const [staticContext, projectContext, ragItems] = await Promise.all([
    loadBlobText(STATIC_CONTEXT_BLOB),
    loadBlobText(PROJECT_CONTEXT_BLOB),
    retrieveRagItems(db, userQuery),
  ]);

  return { staticContext, projectContext, ragItems };
}

/**
 * Assembles the messages array for an Azure AI Foundry chat call.
 * System prompt = static + project context.
 * User message includes RAG context prepended.
 */
export function assembleMessages(
  context: AiContext,
  history: ConversationMessage[],
  userMessage: string,
): ConversationMessage[] {
  const systemPrompt = [
    context.staticContext,
    '---',
    context.projectContext,
  ].join('\n\n');

  const ragBlock = formatRagContext(context.ragItems);
  const userMessageWithRag = `${ragBlock}\n\n---\n\n${userMessage}`;

  return [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessageWithRag },
  ];
}

async function loadBlobText(blobPath: string): Promise<string> {
  try {
    return await downloadBlobAsText(env.CMS_BLOB_CONTAINER, blobPath);
  } catch {
    // Return empty string if context files haven't been created yet
    return '';
  }
}
