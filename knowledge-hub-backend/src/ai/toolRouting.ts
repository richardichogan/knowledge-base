import type { LlmToolChoice, LlmToolDefinition } from './foundryClient.js';
import { STRUCTURED_TOOL_NAMES } from './knowledge/structuredTools.js';
import { resolveRetrievalScope } from './knowledge/retrievalScope.js';
import { dialogueTurnMode, isConversationalTurn, referencesOtherMaterial } from './dialoguePolicy.js';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/i;
const MIN_PROJECT_TOKEN_CHARS = 4;
const NOTE_EDIT_PATTERN =
  /\b(?:add|insert|append|prepend|put|write|update|edit|rewrite|re-?word|fix|tidy|clean\s+up|restructure|reformat|reorgani[sz]e|turn|convert|replace|remove|delete|expand|shorten|condense|correct)\b[\s\S]{0,120}\b(?:note|section|paragraph|heading|intro(?:duction)?|conclusion|summary|bullets?|list|checklist|table|action\s+items?|next\s+steps|this|it|top|bottom|end|start)\b/i;
const EXPLICIT_NOTE_TARGET_PATTERN = /\b(?:note|section|paragraph|heading|intro(?:duction)?|conclusion|summary|bullets?|list|checklist|table|action\s+items?)\b/i;
const DIRECT_EDIT_REQUEST_PATTERN = /^\s*(?:please\s+)?(?:add|insert|append|prepend|put|write|update|edit|rewrite|re-?word|fix|tidy|clean\s+up|restructure|reformat|reorgani[sz]e|turn|convert|replace|remove|delete|expand|shorten|condense|correct)\b/i;
const SELF_CAPABILITY_QUESTION_PATTERN =
  /\b(?:who\s+are\s+you|what\s+(?:are\s+you|can\s+you\s+do)|(?:your|athena['’]s)\s+(?:own\s+)?(?:identity|capabilities|role|purpose|limitations)|(?:about\s+yourself|know\s+about\s+yourself)|what\s+tools\s+(?:do\s+you\s+have|can\s+you\s+use))\b/i;

export function isAssistantCapabilityQuestion(message: string): boolean {
  return SELF_CAPABILITY_QUESTION_PATTERN.test(message);
}
// Requests that mention another destination are not edits to the note.
const NOT_A_NOTE_EDIT_PATTERN = /\b(?:sparks?|tasks?|plan\s+board|to-?do|calendar|e-?mail|remember|from\s+now\s+on|always|never)\b/i;
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
const PERSONAL_SCHEDULE_PATTERN =
  /\b(?:my|our|today'?s)\s+(?:calendar|diary|schedule|meetings?|appointments?|availability)\b|\bam\s+i\s+(?:free|busy)\b|\bwhat(?:'s|\s+is)\s+on\s+today\b|\bwhat\s+(?:am\s+i\s+doing|do\s+i\s+have)\s+today\b/i;
// He points at material held somewhere other than the open document ("Robert's feedback", "notes from
// Dhalia's call", "I've added…", "go find the note"). Answering from the open note alone, or "if…", is wrong.
const OTHER_DAY_PATTERN = /\b(?:tomorrow|yesterday|next|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const TODAY_REQUEST_PATTERN = /\b(?:today|this\s+(?:morning|afternoon|evening))\b/i;

// Tool groups whose schemas are large or specialised; sent only when the turn could plausibly need them.
const DIAGRAM_WRITE_TOOLS = new Set(['create_diagram', 'update_diagram']);
const DIAGRAM_INTENT_PATTERN =
  /\b(?:diagrams?|draw|drawing|flow\s*-?charts?|swim\s*-?lanes?|lanes?|visuali[sz]e|visual|architecture|sketch|shapes?|connectors?|boxes|legend|footnotes?|agentic|ai[\s-]+flow|governance\s+flow|process\s+(?:map|flow))\b/i;
const DISCOVER_ADMIN_TOOLS = new Set([
  'add_discover_source', 'update_discover_source', 'set_discover_item_state', 'inspect_discover_feed', 'create_weekly_microsoft_digest',
]);
const DISCOVER_INTENT_PATTERN =
  /\b(?:discover(?:y)?|feeds?|rss|atom|subscri\w*|sources?|digest|weekly|monday|articles?|shelve\w*|restore|dismiss\w*|park(?:ed|ing)?|later|newsletters?|podcasts?|blog)\b/i;
const DECISION_REVIEW_INTENT_PATTERN =
  /\b(?:decisions?|decided|supersed\w*|assumptions?|revisit|re-?consider|still\s+(?:valid|hold|stand)s?|review\s+(?:date|due)|approval\s+gate)\b/i;

const STRUCTURED_INTENT_PATTERN =
  /\b(?:how\s+many|count|number\s+of|list\s+(?:all|every|the|my)|all\s+(?:my|the|of\s+the)?\s*(?:open\s+|overdue\s+)?tasks?|every\s+(?:task|record|note|item)|overdue|due\s+(?:this|next|last|today|tomorrow)|what\s+(?:has\s+)?changed|changes?\s+(?:this|last|since)|recently\s+(?:changed|updated)|any\s+tasks?|no\s+tasks?|none)\b/i;
const RELATIONSHIP_INTENT_PATTERN =
  /\b(?:depend(?:s|ed|encies|ency)?\s+on|downstream|upstream|consequences?|knock-?on|impacts?|affect(?:s|ed)?|linked?\s+(?:to|with)|connected\s+to|related\s+to|relationships?|what\s+else\s+(?:uses|touches|relies)|blocked\s+by|blocks)\b/i;

/**
 * Withholds specialised tool groups the turn does not need, so the model sees fewer, more relevant
 * choices and less prompt. Conservative: the current message and recent history both count, so
 * follow-ups ("add a box to it") still get the tools.
 */
export function focusTools(
  tools: LlmToolDefinition[],
  turn: { userMessage: string; recentText?: string; hasOpenDiagram?: boolean; knowledgeOrchestration?: boolean },
): LlmToolDefinition[] {
  const text = `${turn.userMessage}\n${turn.recentText ?? ''}`;
  const wantsDiagram = turn.hasOpenDiagram === true || DIAGRAM_INTENT_PATTERN.test(text);
  const wantsDiscover = DISCOVER_INTENT_PATTERN.test(text);
  const wantsDecisionReview = DECISION_REVIEW_INTENT_PATTERN.test(text);
  const wantsTraversal = turn.knowledgeOrchestration === true && RELATIONSHIP_INTENT_PATTERN.test(text);
  const wantsStructured = turn.knowledgeOrchestration === true && STRUCTURED_INTENT_PATTERN.test(text);
  const wantsDemoSpecification = /\bdemo\s+spec(?:ification)?\b/i.test(text);
  const wantsJobs = /\b(?:jobs?|schedul\w*|automat\w*|recurr\w*|cron|digest|daily\s+insights|m365.*(?:import|sync)|publishing\s+workflow)\b/i.test(text);
  return tools.filter((tool) => {
    const name = tool.function.name;
    if (name === 'manage_scheduled_jobs' && !wantsJobs) return false;
    if (name === 'manage_publishing_feeds' && !wantsJobs && !/\b(?:publish\w*|posting|bluesky|bsky|linkedin|editorial|blog)\b/i.test(text)) return false;
    if (name === 'get_demo_specification_template' || name === 'create_demo_specification') return wantsDemoSpecification;
    if (STRUCTURED_TOOL_NAMES.has(name)) return wantsStructured;
    if (name === 'traverse_relationships') return wantsTraversal;
    if (name === 'review_decisions') return wantsDecisionReview;
    if (DIAGRAM_WRITE_TOOLS.has(name)) return wantsDiagram;
    if (DISCOVER_ADMIN_TOOLS.has(name)) return wantsDiscover;
    return true;
  });
}

function findToolName(tools: LlmToolDefinition[], predicate: (name: string) => boolean): string | undefined {
  return tools.find((tool) => predicate(tool.function.name.toLowerCase()))?.function.name;
}

/**
 * Requires external grounding for prompts where an unverified answer is more
 * harmful than the small cost of a search. The requirement applies only to
 * the first model call; after the tool result is present, the normal automatic
 * tool loop resumes so the model can synthesize or perform another lookup.
 */
const DIAGRAM_CREATE_PATTERN = /\b(?:create|draw|make|build|sketch|generate)\s+(?:me\s+)?(?:a|an|the|new|another)?\s*(?:new\s+)?(?:(?:architecture|flow|process|swim\s*-?lane|ai[\s-]+flow|(?:ai\s+)?governance|agentic(?:\s+process)?)\s+)?diagram\b/i;
/** An AI flow / governance (agentic process) diagram, even without the word "diagram". */
const AI_FLOW_CREATE_PATTERN = /\b(?:create|draw|make|build|sketch|generate|map\s+out|map)\s+(?:me\s+)?(?:a|an|the|new|another)?\s*(?:new\s+)?(?:ai[\s-]+flow|ai\s+governance\s+flow|agentic\s+(?:process|flow|workflow)|swim\s*-?lane\s+(?:flow|process|view))\b/i;

const KNOWLEDGE_QUESTION_PATTERN =
  /\?|^\s*(?:what|which|who|whom|whose|when|where|why|how|should|does|did|do|is|are|was|were|can|could|link|compare|connect|summari[sz]e|explain|tell\s+me|show|find|list|give\s+me|quote|read|check|look)\b/i;
const NOT_A_RETRIEVAL_REQUEST_PATTERN =
  /\b(?:create|add|save|remember|update|delete|remove|draft|write|rewrite|schedule|send|set\s+up|mark|rename|move|draw|generate)\b/i;

/**
 * With knowledge orchestration on, a question about his saved material is never answered or
 * clarified from the prompt alone: the first round must retrieve. Decisions go to the decision log
 * (all projects); structured count/list questions keep their own tools; everything else searches.
 */
export function selectKnowledgeRetrievalChoice(userMessage: string, tools: LlmToolDefinition[]): LlmToolChoice | undefined {
  if (isAssistantCapabilityQuestion(userMessage) || isConversationalTurn(userMessage)) return undefined;
  if (dialogueTurnMode([], userMessage) === 'explore'
    && !/\b(?:search|find|read|look\s+(?:up|for)|check\s+(?:the|my))\b/i.test(userMessage)
    && !referencesOtherMaterial(userMessage)) return undefined;
  const scoped = resolveRetrievalScope(userMessage);
  if (scoped?.tool && tools.some(tool => tool.function.name === scoped.tool)) {
    if (scoped.families.includes('task') && STRUCTURED_INTENT_PATTERN.test(userMessage)) return undefined;
    return { type: 'function', function: { name: scoped.tool } };
  }
  if (!KNOWLEDGE_QUESTION_PATTERN.test(userMessage) || NOT_A_RETRIEVAL_REQUEST_PATTERN.test(userMessage)) return undefined;
  if (STRUCTURED_INTENT_PATTERN.test(userMessage) && tools.some((t) => STRUCTURED_TOOL_NAMES.has(t.function.name))) return undefined;
  const preferred = DECISION_REVIEW_INTENT_PATTERN.test(userMessage) && tools.some((t) => t.function.name === 'review_decisions') ? 'review_decisions' : 'search_knowledge_base';
  const name = findToolName(tools, (n) => n === preferred);
  return name === undefined ? undefined : { type: 'function', function: { name } };
}

export function selectRequiredToolChoice(
  userMessage: string,
  tools: LlmToolDefinition[],
  projectReferences: Array<{ label: string; url: string }> = [],
  activeProjectName: string | null = null,
  /** A Think note is open beside the chat and can be edited. */
  hasEditableNote = false,
  /** A mind map is open beside the chat and can be changed. */
  hasEditableMap = false,
  /** A diagram's saved structure is already included (read-only). */
  hasOpenDiagram = false,
): LlmToolChoice | undefined {
  // A lasting preference/correction must be saved, not just acknowledged —
  // left to choose, the model often replies "Remembered" without saving.
  if (STANDING_INSTRUCTION_PATTERN.test(userMessage)) {
    const rememberToolName = findToolName(tools, (name) => name === 'remember');
    if (rememberToolName !== undefined) {
      return { type: 'function', function: { name: rememberToolName } };
    }
  }
  if (isAssistantCapabilityQuestion(userMessage) || isConversationalTurn(userMessage)) return undefined;
  if (dialogueTurnMode([], userMessage) === 'explore' && !referencesOtherMaterial(userMessage)) return undefined;

  // Asked to change the open note: propose an edit (previewed, applied by the
  // user) rather than writing the content into the chat.
  if (hasEditableNote && NOTE_EDIT_PATTERN.test(userMessage) && !NOT_A_NOTE_EDIT_PATTERN.test(userMessage)
    && (EXPLICIT_NOTE_TARGET_PATTERN.test(userMessage) || DIRECT_EDIT_REQUEST_PATTERN.test(userMessage))) {
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

  if (PERSONAL_SCHEDULE_PATTERN.test(userMessage) && TODAY_REQUEST_PATTERN.test(userMessage) && !OTHER_DAY_PATTERN.test(userMessage)) {
    const scheduleToolName = findToolName(tools, name => name === 'get_today_schedule');
    if (scheduleToolName !== undefined) return { type: 'function', function: { name: scheduleToolName } };
  }

  // Asked to draw a new diagram: create it rather than searching existing ones.
  if (DIAGRAM_CREATE_PATTERN.test(userMessage) || AI_FLOW_CREATE_PATTERN.test(userMessage)) {
    const createTool = findToolName(tools, name => name === 'create_diagram');
    if (createTool !== undefined) return { type: 'function', function: { name: createTool } };
  }

  if (/\bdiagrams?\b/i.test(userMessage) &&
    (!hasOpenDiagram || /\b(?:diagrams|other|across|compare|comparison|find|search)\b/i.test(userMessage))) {
    const diagramTool = findToolName(tools, name => name === 'search_diagrams');
    if (diagramTool !== undefined) return { type: 'function', function: { name: diagramTool } };
  }

  if (URL_PATTERN.test(userMessage)) {
    const fetchToolName = findToolName(tools, (name) => name === 'fetch_web_page');
    if (fetchToolName !== undefined) {
      return { type: 'function', function: { name: fetchToolName } };
    }
  }

  if (referencesOtherMaterial(userMessage)) {
    const searchToolName = findToolName(tools, (name) => name === 'search_knowledge_base');
    if (searchToolName !== undefined) return { type: 'function', function: { name: searchToolName } };
  }

  if (INTERNAL_RECORD_QUESTION_PATTERN.test(userMessage)) return undefined;

  const normalizedMessage = userMessage.toLowerCase();
  const namedProjectReference = [
    activeProjectName ?? '',
    ...projectReferences.map((reference) => reference.label),
  ].some((value) => value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token.length >= MIN_PROJECT_TOKEN_CHARS && normalizedMessage.includes(token)));

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
