import type { Project, TaxonomyTag } from '../services/api';
import { colourHex, NEUTRAL_HEX } from './palette';

export type IdentityKind = 'project' | 'group' | 'area' | 'topic';

export interface Identity {
  tagId: string | null;
  label: string;
  kind: IdentityKind;
  /** Theme colour; null for groups. */
  hex: string | null;
  /** Icon key for projects; null otherwise. */
  icon: string | null;
  projectId: string | null;
  /** Area or group name, for tooltips. */
  parentName: string | null;
}

export interface IdentityIndex {
  byTagId: (id: string) => Identity | undefined;
  byName: (name: string) => Identity | undefined;
  byProjectId: (id: string) => Identity | undefined;
  /** Hex for a tag, falling back to neutral; handy for graphs and drag payloads. */
  hexForTag: (id: string) => string;
  ready: boolean;
}

type ProjectIdentityRecord = Pick<Project, 'id' | 'name' | 'colour' | 'icon' | 'tagId' | 'groupName'>;

export function buildIdentityIndex(tree: TaxonomyTag[], projects: readonly ProjectIdentityRecord[]): Omit<IdentityIndex, 'ready'> {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const byTag = new Map<string, Identity>();
  const byName = new Map<string, Identity>();
  const byProject = new Map<string, Identity>();

  const add = (tag: TaxonomyTag, parent: TaxonomyTag | null): void => {
    const project = tag.projectId != null ? projectById.get(tag.projectId) : undefined;
    let identity: Identity;
    if (tag.projectId != null) {
      identity = {
        tagId: tag.id, label: project?.name ?? tag.name, kind: 'project',
        hex: project !== undefined ? colourHex(project.colour) : (tag.colour ?? NEUTRAL_HEX),
        icon: project?.icon ?? 'folder', projectId: tag.projectId, parentName: parent?.name ?? null,
      };
    } else if (tag.role === 'filing') {
      identity = { tagId: tag.id, label: tag.name, kind: 'group', hex: null, icon: null, projectId: null, parentName: null };
    } else if (parent === null) {
      identity = { tagId: tag.id, label: tag.name, kind: 'area', hex: tag.colour ?? NEUTRAL_HEX, icon: null, projectId: null, parentName: null };
    } else {
      identity = {
        tagId: tag.id, label: tag.name, kind: 'topic',
        hex: tag.colour ?? parent.colour ?? NEUTRAL_HEX, icon: null, projectId: null, parentName: parent.name,
      };
    }
    byTag.set(tag.id, identity);
    const key = tag.name.toLowerCase();
    if (!byName.has(key) || identity.kind === 'project') byName.set(key, identity);
    if (identity.projectId !== null) byProject.set(identity.projectId, identity);
  };

  for (const parent of tree) {
    add(parent, null);
    for (const child of parent.children ?? []) add(child, parent);
  }

  // Projects whose tag has not loaded yet still get a stable identity.
  for (const p of projects) {
    if (byProject.has(p.id)) continue;
    const identity: Identity = {
      tagId: p.tagId ?? null, label: p.name, kind: 'project', hex: colourHex(p.colour),
      icon: p.icon ?? 'folder', projectId: p.id, parentName: p.groupName ?? null,
    };
    byProject.set(p.id, identity);
    if (!byName.has(p.name.toLowerCase())) byName.set(p.name.toLowerCase(), identity);
  }

  return {
    byTagId: (id) => byTag.get(id),
    byName: (name) => byName.get(name.trim().toLowerCase()),
    byProjectId: (id) => byProject.get(id),
    hexForTag: (id) => byTag.get(id)?.hex ?? NEUTRAL_HEX,
  };
}

const KIND_RANK: Record<IdentityKind, number> = { project: 0, area: 1, topic: 2, group: 3 };

/**
 * Resolves tag ids to identities, projects first then areas then topics.
 * Drops unknown ids, groups (they only organise projects) and, optionally,
 * the tag of a project already shown on its own.
 */
export function identitiesFor(index: IdentityIndex, ids: readonly string[], excludeProjectId?: string | null): Identity[] {
  const seen = new Set<string>();
  const out: Identity[] = [];
  for (const id of ids) {
    const identity = index.byTagId(id);
    if (identity === undefined || identity.kind === 'group' || seen.has(id)) continue;
    if (excludeProjectId != null && identity.projectId === excludeProjectId) continue;
    seen.add(id);
    out.push(identity);
  }
  return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

/** "name|#hex" pairs for the data-ctx-tags drag payload used by canvases. */
export function ctxTags(identities: readonly Identity[]): string | undefined {
  if (identities.length === 0) return undefined;
  return identities.map((i) => (i.hex !== null ? `${i.label}|${i.hex}` : i.label)).join(',');
}
