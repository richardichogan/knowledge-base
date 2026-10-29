import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select } from '@carbon/react';
import { groupProjectsByParent, ProjectOptions } from '../src/components/ProjectOptions';
import { CONTENT_TYPE_GROUPS, CONTENT_TYPE_OPTIONS } from '../src/notes/constants';
import { projectPickerProjects as projects } from './projectPickerFixtures';

test('projects are grouped IBM, Nelfin, Personal, then ungrouped, alphabetically within each', () => {
  const groups = groupProjectsByParent(projects);
  assert.deepEqual(groups.map((group) => [group.label, group.projects.map((p) => p.id)]), [
    ['IBM', ['imagine', 'reckitt']],
    ['Nelfin', ['healthwise']],
    ['Personal', ['blog-site', 'personal']],
    ['Other', ['stray']],
  ]);
});

test('archived and completed projects stay hidden unless they are the current selection', () => {
  const ibm = groupProjectsByParent(projects, ['atom', 'acre'])[0];
  assert.deepEqual(ibm?.projects.map((p) => p.id), ['acre', 'atom', 'imagine', 'reckitt']);
});

test('legacy choices retain their IDs and paused projects remain selectable without mutating input', () => {
  const items = [
    { id: 'personal', name: 'Personal / unassigned', groupName: 'Personal' },
    { ...projects[0]!, lifecycleState: 'paused' as const },
    { id: 'legacy-id', name: 'Legacy / unknown project: legacy-id' },
  ];
  const before = structuredClone(items);
  assert.deepEqual(groupProjectsByParent(items).map(group => [group.label, group.projects.map(p => p.id)]), [
    ['Nelfin', ['healthwise']], ['Personal', ['personal']], ['Other', ['legacy-id']],
  ]);
  assert.deepEqual(items, before);
});

test('native and Carbon project selectors render the same groups and retain archived selections', () => {
  for (const component of ['select', Select] as const) {
    const html = renderToStaticMarkup(createElement(component, {
      id: 'project-picker', value: 'atom', onChange: () => undefined,
      ...(component === 'select' ? {} : { labelText: 'Project' }),
    }, createElement(ProjectOptions, { projects, selected: 'atom' })));
    assert.deepEqual([...html.matchAll(/<optgroup[^>]+label="([^"]+)"/g)].map(match => match[1]),
      ['IBM', 'Nelfin', 'Personal', 'Other']);
    assert.match(html, /value="atom" selected=""/);
    assert.doesNotMatch(html, /value="acre"/);
    assert.match(html, /value="personal">General/);
  }
});

test('every content type sits in exactly one group and keeps its stored id', () => {
  const grouped = CONTENT_TYPE_GROUPS.flatMap((group) => group.options.map((option) => option.id));
  assert.equal(grouped.length, CONTENT_TYPE_OPTIONS.length);
  assert.deepEqual([...grouped].sort(), [
    'architecture', 'blog', 'definition', 'design', 'meeting', 'newsletter', 'note', 'podcast', 'podcast-episode', 'podcast-show-notes',
    'project', 'research', 'script', 'spec', 'use-case',
  ]);
});
