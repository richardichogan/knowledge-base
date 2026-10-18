import type { CfpWorkflowState, DiscoverSort, DiscoverWorkflowState } from '../services/api';
import { DISCOVER_FORMATS, type DiscoverFormat } from '../types/discover';
import { parsePlanPreferences, type PlanPreferences } from './planPreferences';

export type DiscoverTab = DiscoverWorkflowState | 'inbox' | 'cfps' | 'watchlists';
export interface DiscoverPreferences {
  version: 1; kind: 'discover'; tab: DiscoverTab; source: string; title: string;
  sort: DiscoverSort; cfpState: CfpWorkflowState;
  /** Publishing format to rank for; '' ranks overall. Optional so older saved views still load. */
  format?: DiscoverFormat | '';
}
export type WorkspaceView = (PlanPreferences & { kind: 'plan' }) | DiscoverPreferences;
export interface SavedView { id: string; name: string; view: WorkspaceView }
export const SAVED_VIEWS_KEY = 'kh-saved-views-v1';
export const DISCOVER_PREFERENCES_KEY = 'kh-discover-preferences-v1';
export const DEFAULT_DISCOVER_VIEW: DiscoverPreferences = {
  version: 1, kind: 'discover', tab: 'to-review', source: '', title: '', sort: 'weighted', cfpState: 'to_review', format: '',
};
const TABS: DiscoverTab[] = ['to-review', 'saved', 'blog', 'archived', 'published', 'shelved', 'inbox', 'cfps', 'watchlists'];
const CFP_STATES: CfpWorkflowState[] = ['to_review', 'saved', 'submitted', 'archived'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
    && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

export function parseWorkspaceView(value: unknown): WorkspaceView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid saved view.');
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'plan') {
    if (Object.keys(record).some(key => !['version', 'kind', 'view', 'project', 'tag'].includes(key))) throw new Error('Invalid Plan view.');
    return { ...parsePlanPreferences(JSON.stringify(record)), kind: 'plan' };
  }
  if (record['kind'] !== 'discover' || record['version'] !== 1
    || Object.keys(record).some(key => !['version', 'kind', 'tab', 'source', 'title', 'sort', 'cfpState', 'format'].includes(key))
    || !TABS.some(tab => tab === record['tab']) || !CFP_STATES.some(state => state === record['cfpState'])
    || !['weighted', 'editorial', 'latest'].includes(String(record['sort']))
    || !text(record['source'], 256) || !text(record['title'], 256)
    || (record['format'] !== undefined && record['format'] !== '' && !DISCOVER_FORMATS.some(f => f.id === record['format']))) {
    throw new Error('Invalid Discovery view.');
  }
  return {
    version: 1, kind: 'discover', tab: record['tab'] as DiscoverTab, source: record['source'],
    title: record['title'], sort: record['sort'] as DiscoverSort, cfpState: record['cfpState'] as CfpWorkflowState,
    format: (record['format'] ?? '') as DiscoverFormat | '',
  };
}

export function parseSavedViews(raw: string | null): SavedView[] {
  if (raw === null) return [];
  if (raw.length > 32_000) throw new Error('Saved views exceed the device storage limit.');
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) throw new Error('Invalid saved views.');
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1 || !Array.isArray(record['items']) || record['items'].length > 20) throw new Error('Invalid saved views.');
  const ids = new Set<string>();
  const names = new Set<string>();
  return record['items'].map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid saved view.');
    const entry = item as Record<string, unknown>;
    if (typeof entry['id'] !== 'string' || !UUID.test(entry['id']) || ids.has(entry['id'])
      || !text(entry['name'], 64) || !entry['name'].trim()) throw new Error('Invalid saved view name or identity.');
    const view = parseWorkspaceView(entry['view']);
    const name = entry['name'].trim();
    const identity = `${view.kind}:${name.toLocaleLowerCase('en-GB')}`;
    if (names.has(identity)) throw new Error('Duplicate saved view names.');
    ids.add(entry['id']);
    names.add(identity);
    return { id: entry['id'], name, view };
  });
}

export function parseSharedView(search: string, kind: WorkspaceView['kind']): WorkspaceView | null {
  const values = new URLSearchParams(search).getAll('view');
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0]!.length > 4096) throw new Error('Invalid shared view link.');
  const view = parseWorkspaceView(JSON.parse(values[0]!) as unknown);
  if (view.kind !== kind) throw new Error('This shared view belongs to a different workspace.');
  return view;
}

export function sharedViewUrl(url: URL, view: WorkspaceView): string {
  const result = new URL(url);
  result.searchParams.set('view', JSON.stringify(parseWorkspaceView(view)));
  return result.toString();
}
