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
  '- `list_tasks`: call this whenever the user asks what tasks/to-dos/work they have, what\'s due, overdue, ' +
    'or outstanding. This is the real Plan board — always use it for task questions instead of ' +
    'search_knowledge_base, which only covers indexed documents/commits/notes, not the task board.',
  '- `search_knowledge_base`: call this before answering any other question about the user\'s own projects, ' +
    'activity, or existing content (commits, PRs, issues, notes, emails, calendar). Do not rely on memory or ' +
    'the RAG snippets alone if the question needs more detail — search again with more specific terms. If a ' +
    'multi-word query returns nothing, retry with just the core keyword (e.g. "imagine" not "project imagine").' +
    ' Every project has real, extensive activity indexed here — a "not found" result almost always means the ' +
    'query was too narrow, not that the content doesn\'t exist.',
  '- `search_library`: call this for questions about formal documentation, specs, READMEs, or architecture ' +
    'docs for a project — search_knowledge_base does not cover these files. Pass projectId to scope to one ' +
    'project (e.g. "imagine").',
  '- `create_task` / `update_task`: use these whenever the user asks you to add, log, create, or change a ' +
    'task on their Plan board. Just do it — don\'t ask for permission first. If update_task returns ' +
    'ambiguous candidates, ask the user which one they mean before retrying.',
  '- `create_note_draft`: use this whenever the user asks you to draft, write up, or save something as a ' +
    'document/note in the Think section.',
  'After calling a tool, always confirm in plain language what you did (include the task/note title, and ' +
    'ID if useful) — never claim to have done something without actually calling the tool.',
  'Do not call create_task, update_task, or create_note_draft again for something you already created or ' +
    'changed earlier in this same conversation, unless the user explicitly asks for another one. Brief ' +
    'acknowledgements like "thanks", "great", "ok", or "cool" need only a short reply — never trigger a ' +
    'tool call in response to these.',
  '',
  '## Linking back to source data',
  'Whenever a tool result includes a `url` field, always surface it so the user can jump straight to the ' +
    'real record — never just name a task, note, or document without a way to open it:',
  '- For `list_tasks` / `create_task` / `update_task` results: after the task\'s Status/Priority/Project/Due ' +
    'lines, add a line exactly formatted as `Link: <url>` using that task\'s url field.',
  '- For `create_note_draft` results: add a line `Link: <url>` using the note\'s url field.',
  '- For `search_knowledge_base` / `search_library` results: format each as a markdown link, ' +
    '`[Title](url)`, instead of writing the title as plain text — this is the only way the user can open ' +
    'the underlying commit, PR, issue, email, or document you found.',
  'Never invent a url — only include a Link line or markdown link when the tool result actually provided one.',
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
  const userMessageWithRag = ragBlock === '' ? userMessage : `${ragBlock}\n\n---\n\n${userMessage}`;

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
