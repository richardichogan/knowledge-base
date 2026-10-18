import { api } from '../services/api';
import { noteDraftIdentity } from '../services/auth';
import { requireApiData } from '../services/apiError';
import { ENTITY_LINK_TYPES, type EntityLinkType } from './entityLinks';

const titles = new Map<string, string>();
let epoch = noteDraftIdentity.epoch();
function key(type: EntityLinkType, id: string): string {
  if (epoch !== noteDraftIdentity.epoch()) { titles.clear(); epoch = noteDraftIdentity.epoch(); }
  return `${type}:${id}`;
}

export function setLinkLabel(type: EntityLinkType, id: string, title: string | undefined): void {
  const ref = key(type, id);
  if (title) titles.set(ref, title);
  else titles.delete(ref);
}

export function linkLabel(type: EntityLinkType, id: string): string {
  return titles.get(key(type, id)) ?? `Unavailable ${type}`;
}

export function inlineText(value: unknown): string {
  if (Array.isArray(value)) return value.map(inlineText).join('');
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value : '';
  const item = value as { type?: string; text?: string; props?: { noteId?: string; entityType?: EntityLinkType; entityId?: string }; content?: unknown };
  if (item.type === 'noteMention' && item.props?.noteId) return linkLabel('note', item.props.noteId);
  if (item.type === 'entityMention' && item.props?.entityType && item.props.entityId) return linkLabel(item.props.entityType, item.props.entityId);
  return item.text ?? inlineText(item.content);
}

/** Exports can be invoked before a renderer has looked up its references. */
export async function prepareEntityLinkExport(blocks: unknown): Promise<void> {
  const refs = new Map<string, { type: EntityLinkType; id: string }>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const props = item['props'] as Record<string, unknown> | undefined;
    const type = item['type'] === 'noteMention' ? 'note' : item['type'] === 'entityMention' ? props?.['entityType'] : undefined;
    const id = item['type'] === 'noteMention' ? props?.['noteId'] : props?.['entityId'];
    if (typeof type === 'string' && ENTITY_LINK_TYPES.some(t => t === type) && typeof id === 'string') {
      refs.set(`${type}:${id}`, { type: type as EntityLinkType, id });
    }
    Object.values(item).forEach(walk);
  };
  walk(blocks);
  await Promise.all([...refs.values()].map(async ({ type, id }) => {
    const targets = requireApiData(await api.getLinkTargets('', type, id));
    setLinkLabel(type, id, targets[0]?.title);
  }));
}
