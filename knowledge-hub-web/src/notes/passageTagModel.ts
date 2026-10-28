export const PASSAGE_TAGS = {
  important: { label: 'Important', icon: '!' },
  followUp: { label: 'Follow-up', icon: '↗' },
  question: { label: 'Question', icon: '?' },
  risk: { label: 'Risk', icon: '△' },
  issue: { label: 'Issue', icon: '◆' },
} as const;

export type PassageTag = keyof typeof PASSAGE_TAGS;

export function passageTagKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(walk); return; }
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.length > 0 && record.styles && typeof record.styles === 'object') {
      for (const [kind, id] of Object.entries(record.styles)) {
        if (kind in PASSAGE_TAGS && typeof id === 'string') keys.add(`${kind}:${id}`);
      }
    }
    Object.entries(record).forEach(([key, child]) => { if (key !== 'styles') walk(child); });
  };
  walk(value);
  return keys;
}
