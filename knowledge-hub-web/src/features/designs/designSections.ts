import type { DesignDetail, DesignRole } from '../../types/designs';

export function resolveDesignTab(design: DesignDetail | undefined, tab: Exclude<DesignRole, 'reference'>, targetId: string | null) {
  const assets = design?.assets.filter(item => item.role === tab) ?? [];
  const chosen = targetId && assets.some(item => item.sourceId === targetId) ? targetId : design?.selections[tab];
  const asset = chosen ? assets.find(item => item.sourceId === chosen) : assets.length === 1 ? assets[0] : undefined;
  return { assets, asset, noteId: asset?.available && asset.sourceType === 'note' ? asset.sourceId : null };
}
