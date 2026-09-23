import type { LlmToolChoice, LlmToolDefinition } from './foundryClient.js';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/i;
const EXPLICIT_WEB_LOOKUP_PATTERN =
  /\b(?:search(?:\s+the\s+web)?|web\s+search|look\s+(?:it\s+)?up|google|find\s+(?:it\s+)?online)\b/i;
const CURRENT_OR_NEW_PATTERN =
  /\b(?:latest|recent(?:ly)?|new(?:ly)?|today|yesterday|this\s+week|just\s+(?:announced|released|launched)|only\s+(?:just\s+)?heard|started\s+hearing|since\s+yesterday)\b/i;
const DEFINING_ACRONYM_PATTERN =
  /\b(?:what\s+is|what(?:'s|\s+does)|define|meaning\s+of|stands?\s+for)\b[\s\S]{0,80}\b[A-Z][A-Z0-9-]{1,9}\b/;
const CHALLENGING_UNSUPPORTED_ANSWER_PATTERN =
  /\b(?:that(?:'s|\s+is)\s+(?:wrong|not\s+right)|you(?:'re|\s+are)\s+wrong|do\s+not\s+(?:guess|jump)|stop\s+guessing|actually\s+means?)\b/i;
const PROJECT_REFERENCE_QUESTION_PATTERN =
  /\b(?:what\s+is|how\s+does|capabilit(?:y|ies)|feature|architecture|positioning|product|platform|framework|current\s+state|latest)\b/i;
const INTERNAL_RECORD_QUESTION_PATTERN =
  /\b(?:tasks?|to-dos?|work\s+items?|commits?|pull\s+requests?|merge\s+requests?|issues?|notes?|calendar|emails?|activity)\b/i;

function findToolName(tools: LlmToolDefinition[], predicate: (name: string) => boolean): string | undefined {
  return tools.find((tool) => predicate(tool.function.name.toLowerCase()))?.function.name;
}

/**
 * Requires external grounding for prompts where an unverified answer is more
 * harmful than the small cost of a search. The requirement applies only to
 * the first model call; after the tool result is present, the normal automatic
 * tool loop resumes so the model can synthesize or perform another lookup.
 */
export function selectRequiredToolChoice(
  userMessage: string,
  tools: LlmToolDefinition[],
  projectReferences: Array<{ label: string; url: string }> = [],
  activeProjectName: string | null = null,
): LlmToolChoice | undefined {
  if (URL_PATTERN.test(userMessage)) {
    const fetchToolName = findToolName(tools, (name) => name === 'fetch_web_page');
    if (fetchToolName !== undefined) {
      return { type: 'function', function: { name: fetchToolName } };
    }
  }

  if (INTERNAL_RECORD_QUESTION_PATTERN.test(userMessage)) return undefined;

  const normalizedMessage = userMessage.toLowerCase();
  const namedProjectReference = [
    activeProjectName ?? '',
    ...projectReferences.map((reference) => reference.label),
  ].some((value) => value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token.length >= 4 && normalizedMessage.includes(token)));

  if (
    projectReferences.length > 0 &&
    PROJECT_REFERENCE_QUESTION_PATTERN.test(userMessage) &&
    (namedProjectReference || !DEFINING_ACRONYM_PATTERN.test(userMessage))
  ) {
    const fetchToolName = findToolName(tools, (name) => name === 'fetch_web_page');
    if (fetchToolName !== undefined) {
      return { type: 'function', function: { name: fetchToolName } };
    }
  }

  const requiresWebSearch =
    EXPLICIT_WEB_LOOKUP_PATTERN.test(userMessage) ||
    CURRENT_OR_NEW_PATTERN.test(userMessage) ||
    DEFINING_ACRONYM_PATTERN.test(userMessage) ||
    CHALLENGING_UNSUPPORTED_ANSWER_PATTERN.test(userMessage);

  if (!requiresWebSearch) return undefined;

  const tavilySearchName = findToolName(
    tools,
    (name) => name === 'tavily-search' || (name.includes('tavily') && name.includes('search')),
  );
  return tavilySearchName === undefined
    ? undefined
    : { type: 'function', function: { name: tavilySearchName } };
}
