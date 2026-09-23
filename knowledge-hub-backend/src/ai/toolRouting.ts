import type { LlmToolChoice, LlmToolDefinition } from './foundryClient.js';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/i;
const EXPLICIT_WEB_LOOKUP_PATTERN =
  /\b(?:search(?:\s+the\s+web)?|web\s+search|look\s+(?:it\s+)?up|google|find\s+(?:it\s+)?online)\b/i;
const CURRENT_OR_NEW_PATTERN =
  /\b(?:latest|recent(?:ly)?|current(?:ly)?|new(?:ly)?|today|yesterday|this\s+week|just\s+(?:announced|released|launched)|only\s+(?:just\s+)?heard|started\s+hearing|since\s+yesterday)\b/i;
const DEFINING_ACRONYM_PATTERN =
  /\b(?:what\s+is|what(?:'s|\s+does)|define|meaning\s+of|stands?\s+for)\b[\s\S]{0,80}\b[A-Z][A-Z0-9-]{1,9}\b/;
const CHALLENGING_UNSUPPORTED_ANSWER_PATTERN =
  /\b(?:that(?:'s|\s+is)\s+(?:wrong|not\s+right)|you(?:'re|\s+are)\s+wrong|do\s+not\s+(?:guess|jump)|stop\s+guessing|actually\s+means?)\b/i;

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
): LlmToolChoice | undefined {
  if (URL_PATTERN.test(userMessage)) {
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
