/**
 * ai/mapEdits.ts — changes Athena *proposes* to the mind map open next to the
 * chat. Athena refers to ideas by the short aliases in the map outline (n1,
 * n2 …) and to ideas she adds by her own keys; these are resolved here into
 * concrete map changes (with new ids) that the user previews and applies.
 */
import { randomUUID } from 'node:crypto';
import type { MapOp, Side } from '../services/canvasService.js';

export interface MapChangeProposal {
  summary: string;
  ops: MapOp[];
}

type Action = 'add' | 'rename' | 'describe' | 'move' | 'delete' | 'link';
const ACTIONS: readonly Action[] = ['add', 'rename', 'describe', 'move', 'delete', 'link'];
const MAX_CHANGES = 60;
const SUMMARY_MAX_CHARS = 200;

/**
 * Validates Athena's proposed changes against the map's aliases. Returns one
 * proposal per change (each a small list of ops), plus problems to report back.
 */
export function resolveMapChanges(raw: unknown, aliases: Map<string, string>): { proposals: MapChangeProposal[]; problems: string[] } {
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_CHANGES);
  const keys = new Map<string, string>(); // Athena's key for a new idea → its id
  const proposals: MapChangeProposal[] = [];
  const problems: string[] = [];
  const rootId = aliases.get('n1');

  const ref = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const v = value.trim().replace(/^\[|\]$/g, '');
    return aliases.get(v) ?? keys.get(v);
  };

  list.forEach((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>;
    const n = `change ${(i + 1).toString()}`;
    const action = ACTIONS.find((a) => a === c['action']);
    const str = (k: string): string | undefined => { const v = c[k]; return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined; };
    const summary = (str('summary') ?? action ?? 'Change').slice(0, SUMMARY_MAX_CHARS);
    const side: Side | undefined = c['side'] === 'left' || c['side'] === 'right' ? c['side'] : undefined;
    if (action === undefined) { problems.push(`${n}: unknown action`); return; }

    switch (action) {
      case 'add': {
        const parentId = ref(c['parent']);
        const label = str('label');
        if (parentId === undefined) { problems.push(`${n}: "parent" must be an idea alias (e.g. n3) or the key of an idea added earlier`); return; }
        if (label === undefined) { problems.push(`${n}: add needs a "label"`); return; }
        const id = randomUUID();
        const key = str('key');
        if (key !== undefined) keys.set(key, id);
        const body = str('note');
        proposals.push({ summary, ops: [{ op: 'add', id, parentId, label, ...(body !== undefined && { body }), ...(parentId === rootId && side !== undefined && { side }) }] });
        return;
      }
      case 'rename': {
        const id = ref(c['node']);
        const label = str('label');
        if (id === undefined || label === undefined) { problems.push(`${n}: rename needs "node" and "label"`); return; }
        proposals.push({ summary, ops: [{ op: 'update', id, label }] });
        return;
      }
      case 'describe': {
        const id = ref(c['node']);
        const body = str('note');
        if (id === undefined || body === undefined) { problems.push(`${n}: describe needs "node" and "note"`); return; }
        proposals.push({ summary, ops: [{ op: 'update', id, body }] });
        return;
      }
      case 'move': {
        const id = ref(c['node']);
        const parentId = ref(c['parent']);
        if (id === undefined || parentId === undefined) { problems.push(`${n}: move needs "node" and "parent"`); return; }
        if (id === rootId) { problems.push(`${n}: the central idea can't be moved`); return; }
        proposals.push({ summary, ops: [{ op: 'move', id, parentId, ...(parentId === rootId && side !== undefined && { side }) }] });
        return;
      }
      case 'delete': {
        const id = ref(c['node']);
        if (id === undefined) { problems.push(`${n}: delete needs "node"`); return; }
        if (id === rootId) { problems.push(`${n}: the central idea can't be deleted`); return; }
        proposals.push({ summary, ops: [{ op: 'delete', id }] });
        return;
      }
      case 'link': {
        const sourceId = ref(c['node']);
        const targetId = ref(c['to']);
        if (sourceId === undefined || targetId === undefined) { problems.push(`${n}: link needs "node" and "to"`); return; }
        const label = str('label');
        proposals.push({ summary, ops: [{ op: 'link', id: randomUUID(), sourceId, targetId, ...(label !== undefined && { label }) }] });
        return;
      }
    }
  });
  return { proposals, problems };
}
