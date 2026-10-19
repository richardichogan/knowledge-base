import { ENTITY_LINK_LABELS, type EntityLinkType } from '../notes/entityLinks';

/** Something the palette can reopen: an Athena item, a chat or an external source. */
export interface PaletteTarget {
  kind: EntityLinkType | 'chat' | 'source';
  id: string;
  title: string;
  href: string;
}

export const RECENT_KEY = 'kh.palette.recent';
const RECENT_LIMIT = 6;

export const PALETTE_KIND_LABELS: Record<PaletteTarget['kind'], string> = {
  ...ENTITY_LINK_LABELS, chat: 'Athena chat', source: 'Source',
};

export function chatHref(id: string): string {
  return `/chat?session=${encodeURIComponent(id)}`;
}

export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function isTarget(value: unknown): value is PaletteTarget {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item['kind'] === 'string' && item['kind'] in PALETTE_KIND_LABELS
    && typeof item['id'] === 'string' && typeof item['title'] === 'string' && typeof item['href'] === 'string';
}

export function readRecent(storage: Pick<Storage, 'getItem'> | undefined): PaletteTarget[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isTarget).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Most recent first, de-duplicated by kind and id, capped. */
export function pushRecent(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, target: PaletteTarget): PaletteTarget[] {
  const next = [target, ...readRecent(storage).filter(item => item.kind !== target.kind || item.id !== target.id)].slice(0, RECENT_LIMIT);
  try { storage?.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}
