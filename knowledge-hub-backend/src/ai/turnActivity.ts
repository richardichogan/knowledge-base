/**
 * ai/turnActivity.ts — plain-English labels for what Athena is doing during a
 * turn ("Searching your Library for “underwriting queue”"), shown live in the
 * chat while she works.
 */

const LABELS: Record<string, string> = {
  get_project_details: 'Reading current project details',
  search_past_chats: 'Searching your past conversations',
  read_past_chat: 'Reading an earlier conversation',
  get_discover_sources: 'Reading your Discover feed subscriptions',
  inspect_discover_feed: 'Checking a candidate RSS/Atom feed',
  search_knowledge_base: 'Searching your notes and synced content',
  search_library: 'Searching your Library',
  search_diagrams: 'Searching your diagrams',
  read_diagram: 'Reading a saved diagram',
  find_files: 'Looking through your files',
  screenshot_page: 'Taking screenshots',
  get_content_pipeline: 'Checking your content plan',
  set_content_plan: 'Updating your content plan',
  search_knowledge_graph: 'Looking through the knowledge graph',
  search_ica: 'Searching the ICA document collections',
  fetch_web_page: 'Reading a web page',
  list_tasks: 'Checking your tasks',
  create_task: 'Preparing a task',
  update_task: 'Updating a task',
  create_note_draft: 'Drafting a Think note',
  get_demo_specification_template: 'Reading the demo specification template',
  create_demo_specification: 'Validating and saving the demo specification',
  create_spark: 'Saving a Spark',
  propose_note_edit: 'Drafting changes to the note',
  propose_map_changes: 'Drafting changes to the canvas',
  remember: 'Saving to memory',
  save_output: 'Saving to Outputs',
  read_output: 'Reading a saved output',
  get_today_schedule: 'Reading today\'s meetings',
  forget_memory: 'Updating memory',
  list_memories: 'Checking what I remember',
  add_discover_source: 'Adding a Discover source',
  update_discover_source: 'Updating a Discover source',
  set_discover_item_state: 'Moving a Discover article',
  update_spark: 'Updating a Spark',
  create_project: 'Creating a project',
  update_project: 'Updating a project',
  update_note: 'Updating a Think note',
  create_diagram: 'Drawing a diagram',
  update_diagram: 'Updating a diagram',
  create_mind_map: 'Creating a mind map',
  create_weekly_microsoft_digest: 'Collating this week\'s Microsoft updates',
  manage_scheduled_jobs: 'Working with scheduled jobs',
};

/** One line describing a tool call, including what it's looking for when that's short. */
export function describeToolActivity(name: string, argsJson: string): string {
  if (name === 'read_design_package') return 'Reading the linked Design originals and selected revisions';
  if (name === 'save_design_documents') return 'Saving requested documents into their Design tabs';
  let detail = '';
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const value = args['query'] ?? args['q'] ?? args['search'] ?? args['url'] ?? args['feedUrl'] ?? args['title'];
    if (typeof value === 'string' && value.trim() !== '') detail = value.trim();
  } catch {
    // Arguments are optional detail; the label alone is fine.
  }
  if (detail.length > 70) detail = `${detail.slice(0, 67)}…`;
  const label = LABELS[name] ?? (/search/i.test(name) ? 'Searching the web' : `Using ${name.replace(/[_-]+/g, ' ')}`);
  if (detail === '') return label;
  return name === 'fetch_web_page' ? `${label}: ${detail}` : `${label} for “${detail}”`;
}
