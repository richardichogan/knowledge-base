/**
 * components/ProjectOptions.tsx — the <option> list for any project <select>,
 * grouped under the project's parent (IBM, Nelfin, Personal). Archived and
 * completed projects are hidden unless they are the current selection, so old
 * notes keep showing their project without cluttering the picker.
 */

import React from 'react';
import type { Project } from '../services/api';

const PARENT_ORDER = ['IBM', 'Nelfin', 'Personal'];
const UNGROUPED = 'Other';
const HIDDEN_STATES = new Set(['archived', 'completed']);

/** Project identity plus optional lifecycle metadata for legacy/unassigned choices. */
export type ProjectPickerItem = Pick<Project, 'id' | 'name' | 'groupName'> & Partial<Pick<Project, 'lifecycleState'>>;

export interface ProjectOptionGroup {
  label: string;
  projects: ProjectPickerItem[];
}

function parentRank(label: string): number {
  const index = PARENT_ORDER.indexOf(label);
  if (index >= 0) return index;
  return label === UNGROUPED ? PARENT_ORDER.length + 1 : PARENT_ORDER.length;
}

export function groupProjectsByParent(projects: readonly ProjectPickerItem[], selectedIds: readonly string[] = []): ProjectOptionGroup[] {
  const groups = new Map<string, ProjectPickerItem[]>();
  for (const project of projects) {
    if (project.lifecycleState !== undefined && HIDDEN_STATES.has(project.lifecycleState) && !selectedIds.includes(project.id)) continue;
    const label = project.groupName?.trim() || UNGROUPED;
    groups.set(label, [...(groups.get(label) ?? []), project]);
  }
  return [...groups.entries()]
    .map(([label, members]) => ({
      label,
      projects: [...members].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    }))
    .sort((a, b) => parentRank(a.label) - parentRank(b.label) || a.label.localeCompare(b.label));
}

interface ProjectOptionsProps {
  projects: readonly ProjectPickerItem[];
  /** Current value(s) of the select — always listed even if archived. */
  selected?: string | readonly string[];
}

export function ProjectOptions({ projects, selected }: ProjectOptionsProps): React.ReactElement {
  const selectedIds = selected === undefined ? [] : typeof selected === 'string' ? [selected] : selected;
  return (
    <>
      {groupProjectsByParent(projects, selectedIds).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
