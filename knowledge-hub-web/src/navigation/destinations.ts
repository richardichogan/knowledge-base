import {
  Home, Compass, CalendarTools, Idea, Portfolio, Activity, Book,
  Network_3, MachineLearningModel, Renew, Tag, Settings,
} from '@carbon/icons-react';

export type NavigationAction = 'tags' | 'repo-tags';
export interface NavigationDestination {
  id: string;
  label: string;
  icon: typeof Home;
  path?: string;
  action?: NavigationAction;
  description?: string;
}
export interface NavigationGroup {
  label: string;
  items: NavigationDestination[];
}

export const PRIMARY_DESTINATIONS: NavigationDestination[] = [
  { id: 'today', path: '/', label: 'Today', icon: Home },
  { id: 'discover', path: '/discover', label: 'Discover', icon: Compass },
  { id: 'plan', path: '/plan', label: 'Plan', icon: CalendarTools },
  { id: 'think', path: '/think', label: 'Think', icon: Idea },
  { id: 'projects', path: '/projects', label: 'Projects', icon: Portfolio },
];

export const TOOL_GROUPS: NavigationGroup[] = [
  { label: 'Context and records', items: [
    { id: 'activity', path: '/my-work', label: 'Activity', icon: Activity, description: 'Activity from connected systems' },
    { id: 'sources', path: '/library', label: 'Sources', icon: Book, description: 'Indexed documents and source material' },
    { id: 'graph', path: '/graph', label: 'Knowledge graph', icon: Network_3, description: 'Inspect connections across Athena' },
  ] },
  { label: 'Athena configuration', items: [
    { id: 'memory', path: '/memory', label: 'Memory', icon: MachineLearningModel, description: 'Manage what Athena remembers' },
  ] },
  { label: 'Management', items: [
    { id: 'sync', path: '/my-work?sync=1', label: 'Connections and sync', icon: Renew, description: 'Manage connected sources and synchronisation' },
    { id: 'tags', action: 'tags', label: 'Tag Manager', icon: Tag, description: 'Manage tags and review suggestions' },
    { id: 'repo-tags', action: 'repo-tags', label: 'Repo to Tag Mappings', icon: Settings, description: 'Manage repository-to-tag mappings' },
    { id: 'repo-projects', path: '/settings/repo-mappings', label: 'Repo project mappings', icon: Settings, description: 'Manage repository filing project tags' },
  ] },
];

export function matchesDestination(pathname: string, path: string): boolean {
  const base = path.split('?')[0]!;
  return pathname === base || (base !== '/' && pathname.startsWith(`${base}/`));
}

export function selectedTool(pathname: string, search: string): NavigationDestination | undefined {
  const items = TOOL_GROUPS.flatMap((group) => group.items);
  if (pathname === '/my-work' && new URLSearchParams(search).get('sync') === '1') {
    return items.find((item) => item.id === 'sync');
  }
  return items.find((item) => item.path !== undefined && !item.path.includes('?') && matchesDestination(pathname, item.path));
}
