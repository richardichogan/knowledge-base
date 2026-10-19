import type { Project } from '../src/services/api';

function project(id: string, name: string, groupName: string | null, lifecycleState: Project['lifecycleState'] = 'active'): Project {
  return {
    id, name, groupName, lifecycleState, colour: 'teal', icon: 'folder', category: 'personal',
    priority: 'medium', projectType: 'standard', description: '', goal: '', role: '', ownership: '',
    startDate: null, targetEndDate: null, importance: 'normal', expectedOutputs: [], gitlabPaths: [],
    githubRepos: [], hasIcaDocumentCollection: false, icaDocumentCollectionName: '',
    icaDocumentCollectionId: '', links: [], tags: [], createdAt: '', updatedAt: '',
  };
}

export const projectPickerProjects: Project[] = [
  project('healthwise', 'Healthwise', 'Nelfin'),
  project('blog-site', 'Blog Site', 'Personal'),
  project('reckitt', 'Reckitt', 'IBM'),
  project('imagine', 'IMAGINE', 'IBM'),
  project('atom', 'ATOM', 'IBM', 'archived'),
  project('acre', 'ACRE', 'IBM', 'completed'),
  project('stray', 'Stray', null),
  project('personal', 'General', 'Personal'),
];
