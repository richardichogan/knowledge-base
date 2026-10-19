import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupProjectsByParent } from '../src/components/ProjectOptions';
import { CONTENT_TYPE_GROUPS, CONTENT_TYPE_OPTIONS } from '../src/notes/constants';
import type { Project } from '../src/services/api';

function project(id: string, name: string, groupName: string | null, lifecycleState: Project['lifecycleState'] = 'active'): Project {
  return { id, name, groupName, lifecycleState } as Project;
}

const projects = [
  project('healthwise', 'Healthwise', 'Nelfin'),
  project('blog-site', 'Blog Site', 'Personal'),
  project('reckitt', 'Reckitt', 'IBM'),
  project('imagine', 'IMAGINE', 'IBM'),
  project('atom', 'ATOM', 'IBM', 'archived'),
  project('acre', 'ACRE', 'IBM', 'completed'),
  project('stray', 'Stray', null),
];

test('projects are grouped IBM, Nelfin, Personal, then ungrouped, alphabetically within each', () => {
  const groups = groupProjectsByParent(projects);
  assert.deepEqual(groups.map((group) => [group.label, group.projects.map((p) => p.id)]), [
    ['IBM', ['imagine', 'reckitt']],
    ['Nelfin', ['healthwise']],
    ['Personal', ['blog-site']],
    ['Other', ['stray']],
  ]);
});

test('archived and completed projects stay hidden unless they are the current selection', () => {
  const ibm = groupProjectsByParent(projects, ['atom'])[0];
  assert.deepEqual(ibm?.projects.map((p) => p.id), ['atom', 'imagine', 'reckitt']);
});

test('every content type sits in exactly one group and keeps its stored id', () => {
  const grouped = CONTENT_TYPE_GROUPS.flatMap((group) => group.options.map((option) => option.id));
  assert.equal(grouped.length, CONTENT_TYPE_OPTIONS.length);
  assert.deepEqual([...grouped].sort(), [
    'architecture', 'blog', 'meeting', 'newsletter', 'note', 'podcast', 'podcast-show-notes',
    'project', 'research', 'script', 'spec', 'use-case',
  ]);
});
