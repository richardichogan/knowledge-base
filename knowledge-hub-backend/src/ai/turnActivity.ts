/**
 * ai/turnActivity.ts — plain-English labels for what Athena is doing during a
 * turn ("Searching your Library for “underwriting queue”"), shown live in the
 * chat while she works.
 */

const LABELS: Record<string, string> = {
  search_knowledge_base: 'Searching your notes and synced content',
  search_library: 'Searching your Library',
  find_files: 'Looking through your files',
  screenshot_page: 'Taking screenshots',
  search_knowledge_graph: 'Looking through the knowledge graph',
  search_ica: 'Searching the ICA document collections',
  fetch_web_page: 'Reading a web page',
  list_tasks: 'Checking your tasks',
  create_task: 'Preparing a task',
  update_task: 'Updating a task',
  create_note_draft: 'Drafting a Think note',
  propose_note_edit: 'Drafting changes to the note',
  propose_map_changes: 'Drafting changes to the canvas',
  remember: 'Saving to memory',
  save_output: 'Saving to Outputs',
  forget_memory: 'Updating memory',
  list_memories: 'Checking what I remember',
};

/** One line describing a tool call, including what it's looking for when that's short. */
export function describeToolActivity(name: string, argsJson: string): string {
  let detail = '';
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const value = args['query'] ?? args['q'] ?? args['search'] ?? args['url'] ?? args['title'];
    if (typeof value === 'string' && value.trim() !== '') detail = value.trim();
  } catch {
    // Arguments are optional detail; the label alone is fine.
  }
  if (detail.length > 70) detail = `${detail.slice(0, 67)}…`;
  const label = LABELS[name] ?? (/search/i.test(name) ? 'Searching the web' : `Using ${name.replace(/[_-]+/g, ' ')}`);
  if (detail === '') return label;
  return name === 'fetch_web_page' ? `${label}: ${detail}` : `${label} for “${detail}”`;
}
