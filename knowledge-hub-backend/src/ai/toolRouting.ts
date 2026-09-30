import type { LlmToolChoice, LlmToolDefinition } from './foundryClient.js';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/i;
const NOTE_EDIT_PATTERN =
  /\b(?:add|insert|append|prepend|put|write|update|edit|rewrite|re-?word|fix|tidy|clean\s+up|restructure|reformat|reorgani[sz]e|turn|convert|replace|remove|delete|expand|shorten|condense|correct)\b[\s\S]{0,120}\b(?:note|section|paragraph|heading|intro(?:duction)?|conclusion|summary|bullets?|list|checklist|table|action\s+items?|next\s+steps|this|it|top|bottom|end|start)\b/i;
// Requests that mention another destination are not edits to the note.
const NOT_A_NOTE_EDIT_PATTERN = /\b(?:tasks?|plan\s+board|to-?do|calendar|e-?mail|remember|from\s+now\s+on|always|never)\b/i;
// Asked to change the open mind map (ideas, branches, links).
const MAP_EDIT_PATTERN =
  /\b(?:add|expand|extend|grow|develop|brainstorm|suggest|generate|flesh\s+out|pull|bring|put|place|restructure|reorgani[sz]e|regroup|rename|annotate|retype|remove|delete|prune|link(?:ed)?|connect(?:ed)?|disconnect)\b[\s\S]{0,120}\b(?:canvas|map|cards?|c\d+|ideas?|connections?|links?|notes?|documents?|this|it|them)\b/i;
const NEEDS_SEARCH_FIRST_PATTERN = /\b(?:find|search|look\s+(?:for|up)|pull\s+in|bring\s+in|anything\s+(?:about|on)|related|relevant)\b/i;
const LIBRARY_REQUEST_PATTERN = /\b(?:library|documents?|docs?|pdfs?|specs?|prds?|decks?|slides?|files?)\b/i;
const STANDING_INSTRUCTION_PATTERN =
  /\b(?:from\s+now\s+on|going\s+forward|in\s+future\s*,|remember\s+(?:that|to|this)|(?:please\s+)?always\s+(?:include|use|add|end|start|write|put|give|mention|keep|format)|never\s+(?:include|use|add|write|mention|say|start)|(?:don'?t|do\s+not)\s+ever|stop\s+(?:doing|adding|including|using|writing))\b/i;
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
  /** A Think note is open beside the chat and can be edited. */
  hasEditableNote = false,
  /** A mind map is open beside the chat and can be changed. */
  hasEditableMap = false,
): LlmToolChoice | undefined {
  // A lasting preference/correction must be saved, not just acknowledged —
  // left to choose, the model often replies "Remembered" without saving.
  if (STANDING_INSTRUCTION_PATTERN.test(userMessage)) {
    const rememberToolName = findToolName(tools, (name) => name === 'remember');
    if (rememberToolName !== undefined) {
      return { type: 'function', function: { name: rememberToolName } };
    }
  }

  // Asked to change the open note: propose an edit (previewed, applied by the
  // user) rather than writing the content into the chat.
  if (hasEditableNote && NOTE_EDIT_PATTERN.test(userMessage) && !NOT_A_NOTE_EDIT_PATTERN.test(userMessage)) {
    const editToolName = findToolName(tools, (name) => name === 'propose_note_edit');
    if (editToolName !== undefined) {
      return { type: 'function', function: { name: editToolName } };
    }
  }

  // Asked to change the open map: propose changes (previewed, applied by the user).
  // Not when the request needs a search first ("find … and pull it in"): the
  // model must look the content up before it can propose adding it.
  if (hasEditableMap && MAP_EDIT_PATTERN.test(userMessage) && !NOT_A_NOTE_EDIT_PATTERN.test(userMessage) && !NEEDS_SEARCH_FIRST_PATTERN.test(userMessage)) {
    const mapToolName = findToolName(tools, (name) => name === 'propose_map_changes');
    if (mapToolName !== undefined) {
      return { type: 'function', function: { name: mapToolName } };
    }
  }

  // Asked to find content and put it on the canvas: search first (documents →
  // the Library, anything else → the knowledge base), then propose adding it.
  if (hasEditableMap && MAP_EDIT_PATTERN.test(userMessage) && NEEDS_SEARCH_FIRST_PATTERN.test(userMessage)) {
    const wanted = LIBRARY_REQUEST_PATTERN.test(userMessage) ? 'search_library' : 'search_knowledge_base';
    const searchToolName = findToolName(tools, (name) => name === wanted);
    if (searchToolName !== undefined) {
      return { type: 'function', function: { name: searchToolName } };
    }
  }

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
