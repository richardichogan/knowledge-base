export type PlanView = 'calendar' | 'board' | 'list';
export interface PlanPreferences {
  version: 1;
  view: PlanView;
  project: string;
  tag: string;
}
export const PLAN_PREFERENCES_KEY = 'kh-plan-preferences-v1';
export const DEFAULT_PLAN_PREFERENCES: PlanPreferences = { version: 1, view: 'board', project: '', tag: '' };

export function parsePlanPreferences(raw: string | null): PlanPreferences {
  if (raw === null) return { ...DEFAULT_PLAN_PREFERENCES };
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid Plan preferences.');
  const value = parsed as Record<string, unknown>;
  const view = value['view'];
  const validScope = (scope: unknown): scope is string =>
    typeof scope === 'string' && scope.length <= 256 && [...scope].every(character => character.charCodeAt(0) >= 32);
  if (value['version'] !== 1 || (view !== 'calendar' && view !== 'board' && view !== 'list')
    || !validScope(value['project']) || !validScope(value['tag'])) throw new Error('Invalid Plan preferences.');
  return { version: 1, view, project: value['project'], tag: value['tag'] };
}
