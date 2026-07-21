import type { Pool } from 'pg';
import { downloadBlobAsText } from '../integrations/cms/blobClient.js';
import { env } from '../config/env.js';
import { retrieveRagItems, formatRagContext } from './ragRetriever.js';
import type { AiContext, ConversationMessage } from '../types/aiContext.js';

const STATIC_CONTEXT_BLOB = 'config/static-context.md';
const PROJECT_CONTEXT_BLOB = 'config/project-context.md';

/**
 * Tells the model what it can actually do. Without this, function-calling
 * capability sits unused — the model has no reason to believe it can create
 * tasks/notes or search the knowledge base rather than just chatting.
 */
const TOOL_CAPABILITIES_BLURB = [
  '## Capabilities',
  'You have tools available — use them proactively, don\'t just describe what you would do:',
  '- `search_knowledge_base`: call this before answering any question about the user\'s own projects, ' +
    'activity, or existing content. Do not rely on memory or the RAG snippets alone if the question needs ' +
    'more detail — search again with more specific terms.',
  '- `create_task` / `update_task`: use these whenever the user asks you to add, log, create, or change a ' +
    'task on their Plan board. Just do it — don\'t ask for permission first. If update_task returns ' +
    'ambiguous candidates, ask the user which one they mean before retrying.',
  '- `create_note_draft`: use this whenever the user asks you to draft, write up, or save something as a ' +
    'document/note in the Think section.',
  'After calling a tool, always confirm in plain language what you did (include the task/note title, and ' +
    'ID if useful) — never claim to have done something without actually calling the tool.',
].join('\n');

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
 * System prompt = static + project context + tool capability instructions.
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
    '---',
    TOOL_CAPABILITIES_BLURB,
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
