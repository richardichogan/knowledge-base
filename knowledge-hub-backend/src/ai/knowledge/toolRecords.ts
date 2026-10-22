/**
 * Registers the records returned by the legacy record tools (list_tasks, find_files,
 * get_project_details, review_decisions) in the evidence ledger, with canonical refs.
 * Listed records are Found; records whose content or detail was returned are Read.
 */
import { createHash } from 'node:crypto';
import { noteFound, noteRead, type EvidenceLedger } from './evidence.js';

export const RECORD_TOOLS: ReadonlySet<string> = new Set(['list_tasks', 'find_files', 'get_project_details', 'review_decisions']);
export const STRUCTURED_RESULT_TOOLS: ReadonlySet<string> = new Set(['knowledge_count_tasks', 'knowledge_list_tasks', 'knowledge_list_changes']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const objects = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

function readJson(ledger: EvidenceLedger, kind: string, row: Obj, title: string | null, projectId: string | null): void {
  const id = str(row['id']);
  if (id === null) return;
  noteRead(ledger, { kind, id }, { title, projectId, text: JSON.stringify(row) });
}

function recordTasks(ledger: EvidenceLedger, result: Obj): void {
  for (const t of objects(result['tasks'])) {
    const id = str(t['id']);
    if (id === null) continue;
    const meta = { title: str(t['title']), projectId: str(t['projectId']), locator: str(t['url']) };
    if (typeof t['body'] === 'string') readJson(ledger, 'task', t, meta.title, meta.projectId);
    else noteFound(ledger, { kind: 'task', id }, meta);
  }
}

function recordFiles(ledger: EvidenceLedger, result: Obj): void {
  for (const f of objects(result['files'])) {
    const id = str(f['id']);
    if (id === null) continue;
    const title = str(f['title']);
    if (typeof f['content'] === 'string') noteRead(ledger, { kind: 'item', id }, { title, text: f['content'] });
    else noteFound(ledger, { kind: 'item', id }, { title, locator: str(f['url']) });
  }
}

function recordProject(ledger: EvidenceLedger, result: Obj): void {
  const p = result['project'];
  if (isObj(p)) readJson(ledger, 'project', p, str(p['name']), str(p['id']));
}

const CONTENT_ITEM_PREFIX = 'content_item:';

function canonicalRef(ref: unknown): { kind: string; id: string } | null {
  if (!isObj(ref)) return null;
  const kind = str(ref['kind']);
  const id = str(ref['id']);
  if (kind === null || id === null) return null;
  return kind === 'source' && id.startsWith(CONTENT_ITEM_PREFIX) ? { kind: 'item', id: id.slice(CONTENT_ITEM_PREFIX.length) } : { kind, id };
}

function recordDecisions(ledger: EvidenceLedger, result: Obj): void {
  for (const review of objects(result['reviews'])) {
    const recorded = review['recorded'];
    if (isObj(recorded)) {
      const ref = canonicalRef(recorded['ref']);
      if (ref !== null) noteRead(ledger, ref, { title: null, text: JSON.stringify(recorded) });
    }
    const facts = review['facts'];
    if (!isObj(facts)) continue;
    for (const list of [facts['explicitTasks'], facts['inferredTaskCandidates']]) {
      for (const r of Array.isArray(list) ? list : []) {
        const ref = canonicalRef(r);
        if (ref !== null) noteFound(ledger, ref);
      }
    }
    for (const entry of [...objects(facts['explicitRisks']), ...objects(facts['rationaleSources'])]) {
      const ref = canonicalRef(entry['ref']);
      if (ref === null) continue;
      const title = str(entry['title']);
      if (typeof entry['excerpt'] === 'string') noteRead(ledger, ref, { title, text: entry['excerpt'] });
      else noteFound(ledger, ref, { title });
    }
  }
}

/** Registers a record tool's result; error and non-record results register nothing. */
export function recordRecordTool(ledger: EvidenceLedger, toolName: string, result: unknown): void {
  if (!isObj(result) || 'error' in result) return;
  if (toolName === 'list_tasks') recordTasks(ledger, result);
  else if (toolName === 'find_files') recordFiles(ledger, result);
  else if (toolName === 'get_project_details') recordProject(ledger, result);
  else if (toolName === 'review_decisions') recordDecisions(ledger, result);
}

/** A count has no record ids, so the query itself is registered as a read, citable result. */
export const COUNT_QUERY_KIND = 'query';

/** Registers exact structured results: listed rows were shown with their fields (Read); a count is a Read query result. */
const COUNT_KEY_LENGTH = 12;

export function recordStructuredTool(ledger: EvidenceLedger, toolName: string, result: unknown, args: Obj = {}): void {
  if (!isObj(result) || 'error' in result || (result['status'] !== undefined && result['status'] !== 'ok')) return;
  if (toolName === 'knowledge_count_tasks') {
    const key = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, COUNT_KEY_LENGTH);
    noteRead(ledger, { kind: COUNT_QUERY_KIND, id: `tasks-count:${key}` }, { title: 'Task count', text: JSON.stringify(result), fields: ['total'] });
    return;
  }
  const kind = toolName === 'knowledge_list_tasks' ? 'task' : toolName === 'knowledge_list_changes' ? 'item' : null;
  if (kind === null) return;
  for (const row of objects(result['items'])) {
    const id = str(row['id']);
    if (id !== null) readJson(ledger, kind, row, str(row['title']), str(row['projectId']));
  }
}
