export type PlanView = 'board' | 'focus' | 'use-cases';
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
  // Calendar was removed (falls back to the board) and List became Focus.
  const view = value['view'] === 'calendar' ? 'board' : value['view'] === 'list' ? 'focus' : value['view'];
  const validScope = (scope: unknown): scope is string =>
    typeof scope === 'string' && scope.length <= 256 && [...scope].every(character => character.charCodeAt(0) >= 32);
  if (value['version'] !== 1 || (view !== 'board' && view !== 'focus' && view !== 'use-cases')
    || !validScope(value['project']) || !validScope(value['tag'])) throw new Error('Invalid Plan preferences.');
  return { version: 1, view, project: value['project'], tag: value['tag'] };
}
