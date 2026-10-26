import type { LlmToolDefinition } from './foundryClient.js';
import { RETRIEVAL_SCOPE_PARAMETERS } from './knowledge/retrievalScope.js';

const CORE_TOOLS = new Set([
  'search_knowledge_base', 'read_knowledge_record', 'search_library',
  'search_past_chats', 'read_past_chat', 'search_diagrams', 'read_diagram',
  'get_today_schedule', 'list_tasks', 'get_discover_sources', 'get_discover_watchlist_records',
  'fetch_web_page', 'read_output', 'knowledge_count_tasks', 'knowledge_list_tasks', 'knowledge_list_changes',
]);
const DESCRIPTION_CHARS = 320;
const MAX_TOOLS_PER_LOAD = 8;
export const LOAD_TOOLS = 'load_tools';

/** A turn-local catalogue of already-permitted capabilities, not generated tags or saved classifications. */
export class ToolCatalog {
  private readonly available: Map<string, LlmToolDefinition>;
  private readonly loaded: Set<string>;

  constructor(tools: LlmToolDefinition[]) {
    this.available = new Map(tools.map(tool => [tool.function.name, tool]));
    this.loaded = new Set(tools.filter(tool => CORE_TOOLS.has(tool.function.name)).map(tool => tool.function.name));
  }

  describe(): string {
    return [
      '## Available capability catalogue',
      'Interpret the request from its meaning, conversation history and application state, including negation and corrections. No keyword selects a tool for you.',
      'Choose tools only when needed. A mention of editing, a document, a diagram or a source is not an instruction to act or a restriction to that collection.',
      'The catalogue lists permitted capabilities. Core read tools are already loaded; call load_tools for other schemas, then invoke them in a later round.',
      'Loading a capability does not execute it, authorise a write, create a tag or create an approval task. Existing action and preview safeguards still apply.',
      'For an explicit user-imposed collection, date or project boundary, declare retrievalScope through load_tools before retrieving. Do not declare a hard boundary merely because a collection was mentioned.',
      'Preserve explicit constraints on retries. Use per-query filters for intermediate lookups in a broader comparison. Do not silently widen an explicit boundary after an empty result.',
      ...[...this.available.values()].map(tool => {
        const description = tool.function.description.replace(/\s+/g, ' ');
        return `${tool.function.name}${this.loaded.has(tool.function.name) ? ' [loaded]' : ''}: ${description.slice(0, DESCRIPTION_CHARS)}${description.length > DESCRIPTION_CHARS ? '...' : ''}`;
      }),
    ].join('\n');
  }

  schemas(): LlmToolDefinition[] {
    return [{
      type: 'function',
      function: {
        name: LOAD_TOOLS,
        description: 'Load existing capability schemas for the requested work; no action is executed. Optionally declare explicit retrieval boundaries from the user’s request. Neither tool selection nor scope requires tags or manual classification.',
        parameters: {
          type: 'object',
          properties: {
            names: { type: 'array', items: { type: 'string', enum: [...this.available.keys()] }, minItems: 1, maxItems: MAX_TOOLS_PER_LOAD },
            retrievalScope: RETRIEVAL_SCOPE_PARAMETERS,
          },
          required: ['names'],
          additionalProperties: false,
        },
      },
    }, ...[...this.loaded].map(name => this.available.get(name)!)];
  }

  requestedNames(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOLS_PER_LOAD
      || value.some(name => typeof name !== 'string' || !this.available.has(name))) {
      throw new Error('Load between one and eight tool names from the permitted capability catalogue.');
    }
    return [...new Set(value as string[])];
  }

  load(names: string[]): { loaded: string[]; note: string } {
    const valid = this.requestedNames(names);
    for (const name of valid) this.loaded.add(name);
    return { loaded: valid, note: 'Schemas are available on the next model round. No action has been executed.' };
  }
}
