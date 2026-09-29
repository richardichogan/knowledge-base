/**
 * components/athena/sources.ts — maps backend tool names to the plain-English
 * source a reply drew on ("From: Plan · Library"). Unknown tools are hidden
 * rather than shown as raw identifiers.
 */
const SOURCE_LABELS: Record<string, string> = {
  list_tasks: 'Plan',
  create_task: 'Plan',
  update_task: 'Plan',
  create_note_draft: 'Think',
  search_knowledge_base: 'Knowledge base',
  search_library: 'Library',
  search_knowledge_graph: 'Knowledge graph',
  search_ica: 'IBM Consulting Advantage',
  fetch_web_page: 'Web',
};

/** De-duplicated, ordered source labels for a reply's tool list. */
export function sourceLabels(tools: readonly string[] | undefined): string[] {
  if (tools === undefined) return [];
  return [...new Set(tools.map((t) => SOURCE_LABELS[t]).filter((l): l is string => l !== undefined))];
}
