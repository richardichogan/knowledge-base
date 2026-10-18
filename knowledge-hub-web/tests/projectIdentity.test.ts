import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferProjectId } from '../src/utils/projectMatching';
import { IDENTITY_PALETTE } from '../src/identity/palette';
import { buildIdentityIndex } from '../src/identity/identityIndex';
import type { Project, TaxonomyTag } from '../src/services/api';

const projects = [
  { id: 'imagine', name: 'IMAGINE', githubRepos: ['ibm/imagine'], gitlabPaths: [] },
  { id: 'structara-ai', name: 'Structara AI', githubRepos: [], gitlabPaths: ['structara/ai'] },
];

test('activity project matching uses canonical project records', () => {
  assert.equal(inferProjectId({ repo: 'ibm/imagine' }, undefined, projects), 'imagine');
  assert.equal(inferProjectId({ projectPath: 'structara/ai' }, undefined, projects), 'structara-ai');
  assert.equal(inferProjectId(undefined, 'imagine', projects), 'imagine');
});

test('unmatched activity remains personal instead of inventing a project identity', () => {
  assert.equal(inferProjectId({ repo: 'unknown/repo' }, undefined, projects), 'personal');
  assert.equal(inferProjectId(undefined, 'unknown-project', projects), 'personal');
});

test('a project keeps one colour and icon through its tag, while topics inherit their area colour', () => {
  const imagine: Pick<Project, 'id' | 'name' | 'colour' | 'icon' | 'tagId' | 'groupName'> = {
    id: 'imagine', name: 'IMAGINE', colour: 'indigo', icon: 'idea',
    tagId: 'imagine-tag', groupName: 'IBM Projects',
  };
  const projectTag: TaxonomyTag = {
    id: 'imagine-tag', name: 'IMAGINE', slug: 'imagine', parentId: 'ibm-projects',
    colour: null, role: 'filing', projectId: 'imagine', usageCount: 0,
  };
  const topic: TaxonomyTag = {
    id: 'confidential-computing', name: 'Confidential Computing', slug: 'confidential-computing',
    parentId: 'security-area', colour: null, role: 'concept', usageCount: 0,
  };
  const tree: TaxonomyTag[] = [
    {
      id: 'ibm-projects', name: 'IBM Projects', slug: 'ibm-projects', parentId: null,
      colour: null, role: 'filing', usageCount: 0, children: [projectTag],
    },
    {
      id: 'security-area', name: 'Security and Identity', slug: 'security-and-identity',
      parentId: null, colour: '#ff8389', role: 'concept', usageCount: 0, children: [topic],
    },
  ];

  const index = buildIdentityIndex(tree, [imagine]);
  assert.deepEqual(index.byTagId('imagine-tag'), {
    tagId: 'imagine-tag', label: 'IMAGINE', kind: 'project',
    hex: IDENTITY_PALETTE.indigo, icon: 'idea', projectId: 'imagine', parentName: 'IBM Projects',
  });
  assert.equal(index.byName('IMAGINE')?.hex, IDENTITY_PALETTE.indigo);
  assert.equal(index.byTagId('confidential-computing')?.hex, '#ff8389');
});
