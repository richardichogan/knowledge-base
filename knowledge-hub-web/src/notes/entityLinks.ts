export const ENTITY_LINK_TYPES = ['note', 'spark', 'diagram', 'project', 'task', 'usecase', 'article'] as const;
export type EntityLinkType = typeof ENTITY_LINK_TYPES[number];
export interface EntityLinkTarget { type: EntityLinkType; id: string; title: string; href: string }
export const ENTITY_LINK_LABELS: Record<EntityLinkType, string> = {
  note: 'Note', spark: 'Spark', diagram: 'Diagram', project: 'Project', task: 'Task', usecase: 'Use case', article: 'Article',
};
export interface BacklinkPage { items: EntityLinkTarget[]; hasMore: boolean }

/** Converts plain mentions without touching existing links, code or surrounding text styles. */
export function linkPlainMentions(blocks: unknown, target: EntityLinkTarget): { blocks: unknown; count: number } {
  const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\[\\[${escaped}\\]\\]|(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
  let count = 0;
  type Span = Record<string, unknown> & { type: 'text'; text: string };
  const isSpan = (item: unknown): item is Span => !!item && typeof item === 'object' && 'type' in item
    && item.type === 'text' && 'text' in item && typeof item.text === 'string'
    && !('styles' in item && item.styles && typeof item.styles === 'object' && 'code' in item.styles && item.styles.code === true);
  const convertRun = (run: Span[]): unknown[] => {
    const text = run.map(span => span.text).join('');
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) return run;
    count += matches.length;
    const result: unknown[] = [];
    let offset = 0;
    for (const span of run) {
      const end = offset + span.text.length;
      let cursor = offset;
      for (const match of matches) {
        const start = match.index;
        const stop = start + match[0].length;
        if (start >= end || stop <= offset) continue;
        if (start > cursor) result.push({ ...span, text: text.slice(cursor, start) });
        if (start >= offset) result.push(target.type === 'note'
          ? { type: 'noteMention', props: { noteId: target.id } }
          : { type: 'entityMention', props: { entityType: target.type, entityId: target.id } });
        cursor = Math.min(stop, end);
      }
      if (cursor < end) result.push({ ...span, text: text.slice(cursor, end) });
      offset = end;
    }
    return result;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      let run: Span[] = [];
      for (const item of value) {
        if (isSpan(item)) run.push(item);
        else {
          result.push(...convertRun(run)); run = [];
          result.push(walk(item));
        }
      }
      return [...result, ...convertRun(run)];
    }
    if (!value || typeof value !== 'object') return value;
    const item = value as Record<string, unknown>;
    if (['codeBlock', 'link', 'noteMention', 'entityMention'].includes(String(item['type']))) return value;
    const result = { ...item };
    for (const key of ['content', 'children', 'rows', 'cells']) if (key in result) result[key] = walk(result[key]);
    return result;
  };
  return { blocks: walk(blocks), count };
}

export function entityLinkHref(type: EntityLinkType, id: string): string {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case 'note': return `/think?noteId=${encoded}`;
    case 'spark': return `/think?view=sparks&sparkId=${encoded}`;
    case 'diagram': return `/think?mapId=${encoded}`;
    case 'project': return `/projects?projectId=${encoded}`;
    case 'task': return `/plan?taskId=${encoded}`;
    case 'usecase': return `/plan?view=use-cases&useCase=${encoded}`;
    case 'article': return '/discover';
  }
}

export function wikiQuery(raw: string): { text: string; closed: boolean } {
  return { text: raw.replace(/\]\]$/, '').trim(), closed: raw.endsWith(']]') };
}

/** Query work is delayed, not typing. Superseded callers always settle. */
export function debouncedLinkSearch<T>(search: (query: string) => Promise<T[]>, delay = 120): {
  run: (query: string) => Promise<T[]>; dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ((items: T[]) => void) | undefined;
  let generation = 0;
  return {
    run(query) {
      const current = ++generation;
      clearTimeout(timer);
      pending?.([]);
      return new Promise<T[]>((resolve, reject) => {
        pending = resolve;
        timer = setTimeout(() => {
          void search(query).then(items => {
            if (current === generation) { pending = undefined; resolve(items); }
            else resolve([]);
          }, error => {
            if (current === generation) { pending = undefined; reject(error); }
            else resolve([]);
          });
        }, delay);
      });
    },
    dispose() { generation++; clearTimeout(timer); pending?.([]); pending = undefined; },
  };
}
