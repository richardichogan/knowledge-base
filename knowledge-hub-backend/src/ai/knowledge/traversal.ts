/**
 * Bounded read-only relationship traversal (spec 5.6). Loaders are injected so the
 * walk is pure and mock-testable; it never writes edges.
 */
import { refKey, type EvidenceRef } from './evidence.js';

export const TRAVERSAL_LIMITS = { maxHops: 2, perExpansion: 20, maxVisited: 60 } as const;

export interface RelatedEdge {
  to: EvidenceRef;
  relation: string;
  /** Typed junction / persisted explicit edge vs persisted inferred (similarity, tag) edge. */
  explicit: boolean;
  confidence?: number;
  provenance?: string;
}

export type TargetResolution =
  | { status: 'ok'; title: string | null; projectId: string | null }
  | { status: 'deleted' | 'dangling' | 'excluded' | 'forbidden' };

export interface TraversalStep {
  ref: EvidenceRef;
  key: string;
  hop: number;
  /** Canonical keys from the start to this record, inclusive of both. */
  path: string[];
  relation: string;
  explicit: boolean;
  confidence?: number;
  provenance?: string;
  title: string | null;
  /** Project of the start record, retained so a cross-project path never loses its origin. */
  sourceProjectId: string | null;
  projectId: string | null;
  crossProject: boolean;
  /** The target text has not been read; its contents must not be attributed until it is. */
  readRequired: true;
  label: 'explicit' | 'inferred';
}

export interface TraversalResult {
  start: EvidenceRef;
  steps: TraversalStep[];
  visited: number;
  rejected: Array<{ key: string; reason: string }>;
  truncated: boolean;
  truncatedBy: Array<'neighbours' | 'visited' | 'aborted'>;
  /** Frontier records that could be expanded further in a follow-up. */
  continuation: EvidenceRef[];
}

export interface TraversalInput {
  start: EvidenceRef;
  startProjectId?: string | null;
  loadEdges: (ref: EvidenceRef) => Promise<RelatedEdge[]>;
  resolveTarget: (ref: EvidenceRef) => Promise<TargetResolution>;
  signal?: AbortSignal;
  limits?: Partial<typeof TRAVERSAL_LIMITS>;
}

export async function traverseRelationships(input: TraversalInput): Promise<TraversalResult> {
  const limits = { ...TRAVERSAL_LIMITS, ...input.limits };
  const startKey = refKey(input.start);
  const visited = new Set<string>([startKey]);
  const result: TraversalResult = { start: input.start, steps: [], visited: 1, rejected: [], truncated: false, truncatedBy: [], continuation: [] };
  const truncate = (why: 'neighbours' | 'visited' | 'aborted'): void => {
    result.truncated = true;
    if (!result.truncatedBy.includes(why)) result.truncatedBy.push(why);
  };
  const sourceProjectId = input.startProjectId ?? null;
  let frontier: Array<{ ref: EvidenceRef; path: string[] }> = [{ ref: input.start, path: [startKey] }];

  for (let hop = 1; hop <= limits.maxHops && frontier.length > 0; hop++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      if (input.signal?.aborted === true) { truncate('aborted'); result.continuation.push(node.ref); continue; }
      const edges = await input.loadEdges(node.ref);
      // Explicit edges first so the neighbour cap never drops a typed link in favour of a similarity guess.
      const ordered = [...edges].sort((a, b) => Number(b.explicit) - Number(a.explicit) || (b.confidence ?? 0) - (a.confidence ?? 0));
      let taken = 0;
      for (const edge of ordered) {
        const key = refKey(edge.to);
        if (visited.has(key)) continue;
        if (taken >= limits.perExpansion) { truncate('neighbours'); result.continuation.push(node.ref); break; }
        if (visited.size >= limits.maxVisited) { truncate('visited'); break; }
        visited.add(key);
        taken++;
        const target = await input.resolveTarget(edge.to);
        if (target.status !== 'ok') { result.rejected.push({ key, reason: target.status }); continue; }
        const path = [...node.path, key];
        result.steps.push({
          ref: edge.to, key, hop, path, relation: edge.relation, explicit: edge.explicit,
          ...(edge.confidence !== undefined && { confidence: edge.confidence }),
          ...(edge.provenance !== undefined && { provenance: edge.provenance }),
          title: target.title, sourceProjectId, projectId: target.projectId,
          crossProject: sourceProjectId !== null && target.projectId !== null && sourceProjectId !== target.projectId,
          readRequired: true, label: edge.explicit ? 'explicit' : 'inferred',
        });
        next.push({ ref: edge.to, path });
      }
      if (visited.size >= limits.maxVisited && result.truncatedBy.includes('visited')) break;
    }
    frontier = next;
  }
  result.visited = visited.size;
  return result;
}

/** Wording the model must use for a step: inferred links are suggestions, never dependencies. */
const DECIMALS = 2;
export function describeStep(step: TraversalStep): string {
  const where = step.crossProject ? ' (different project)' : '';
  return step.explicit
    ? `Explicit ${step.relation} link${where}`
    : `Inferred (not confirmed) ${step.relation} suggestion${where}${step.confidence !== undefined ? `, confidence ${step.confidence.toFixed(DECIMALS)}` : ''}`;
}

/** Only explicit steps may be presented as stated relationships; a read is still required before attributing contents. */
export function mayAssertRelationship(step: TraversalStep, isTargetRead: boolean): { relationship: boolean; contents: boolean } {
  return { relationship: step.explicit, contents: isTargetRead };
}
