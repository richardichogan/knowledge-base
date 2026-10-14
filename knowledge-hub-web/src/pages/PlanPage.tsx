/**
 * PlanPage — task planning hub.
 *
 * Board and Focus views of the same tasks behind a view switcher (both render
 * TasksPage, so the Inbox tray, editor and mutations are shared). Only the
 * shared page header and view tabs live here. The inner .page-header of each sub-page is hidden
 * via the .plan-inner wrapper. Athena opens as the floating window (so the
 * board keeps the full width), primed with the visible tasks.
 */

import React, { useEffect, useState } from 'react';
import type { CarbonIconType } from '@carbon/icons-react';
import { CenterCircle, Dashboard, TaskView, Upload } from '@carbon/icons-react';
import { Select, SelectItem } from '@carbon/react';
import { TasksPage } from './TasksPage';
import { useFlatTags } from '../hooks/useTaxonomy';
import { useDueNotifications } from '../hooks/useDueNotifications';
import { useProjects } from '../hooks/useProjects';
import { DEFAULT_PLAN_PREFERENCES, PLAN_PREFERENCES_KEY, parsePlanPreferences, type PlanPreferences, type PlanView } from '../utils/planPreferences';
import { SavedViews } from '../components/SavedViews';
import { DataNotice } from '../components/DataNotice';
import { usePlanAthena } from '../features/plan/usePlanAthena';
import { PlanReviewModal } from '../features/plan/PlanReviewModal';

interface ViewTab {
  key: PlanView;
  label: string;
  Icon: CarbonIconType;
}

const VIEW_TABS: ViewTab[] = [
  { key: 'board',    label: 'Board',     Icon: Dashboard },
  { key: 'focus',    label: 'Focus',     Icon: CenterCircle },
];

export const PlanPage: React.FC = () => {
  const [restored] = useState(() => {
    try { return { preferences: parsePlanPreferences(localStorage.getItem(PLAN_PREFERENCES_KEY)), error: null }; } catch (error) {
      console.warn('[Plan] Could not restore preferences; using the default view.', error);
      return { preferences: { ...DEFAULT_PLAN_PREFERENCES }, error };
    }
  });
  const [preferences, setPreferences] = useState<PlanPreferences>(restored.preferences);
  const [preferenceError, setPreferenceError] = useState<unknown>(restored.error);
  useEffect(() => {
    try { localStorage.setItem(PLAN_PREFERENCES_KEY, JSON.stringify(preferences)); }
    catch (error) { console.warn('[Plan] Could not remember current filters.', error); setPreferenceError(error); }
  }, [preferences]);
  const { view, project: filterProject, tag: filterTag } = preferences;
  const updatePreferences = (patch: Partial<Omit<PlanPreferences, 'version'>>): void => {
    setPreferences(previous => {
      const next = { ...previous, ...patch };
      return next;
    });
  };
  const [importOpen, setImportOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const askAthena = usePlanAthena(filterProject, filterTag);
  const flatTags = useFlatTags();
  const { data: projects = [] } = useProjects();

  // Fire OS/browser notifications for tasks due today (once per session)
  useDueNotifications();

  return (
    <div className="plan-root">
      {/* Shared header */}
      <div className="plan-header page-header">
        <h1 className="page-title">Plan</h1>
        <div className="plan-header__right">
          {(
            <>
              <Select id="plan-filter-project" labelText="Filter by project" hideLabel size="sm"
                value={filterProject} onChange={(e) => updatePreferences({ project: e.target.value })}>
                <SelectItem value="" text="All projects" />
                {filterProject !== '' && !projects.some(project => project.id === filterProject)
                  && <SelectItem value={filterProject} text="Saved project scope (not available)" />}
                {projects.map((p) => <SelectItem key={p.id} value={p.id} text={p.name} />)}
              </Select>
              <Select id="plan-filter-tag" labelText="Filter by tag" hideLabel size="sm"
                value={filterTag} onChange={(e) => updatePreferences({ tag: e.target.value })}>
                <SelectItem value="" text="All tags" />
                {filterTag !== '' && !flatTags.some(tag => tag.id === filterTag)
                  && <SelectItem value={filterTag} text="Saved tag scope (not available)" />}
                {flatTags.map((t) => <SelectItem key={t.id} value={t.id} text={t.name} />)}
              </Select>
              {view === 'board' && <button
                type="button"
                className="kb-import-btn"
                onClick={() => setImportOpen(true)}
                title="Import tasks from a markdown file"
              >
                <Upload size={16} /> Import tasks
              </button>}
            </>
          )}
          <button type="button" className="kb-import-btn" onClick={() => setReviewOpen(true)}
            title="Athena reviews your open tasks and suggests what to reschedule, close or split">
            <TaskView size={16} /> Weekly review
          </button>
          <SavedViews variant="menu" current={{ ...preferences, kind: 'plan' }} onApply={next => {
            if (next.kind === 'plan') updatePreferences({ view: next.view, project: next.project, tag: next.tag });
          }} />
          <div className="plan-view-toggle">
            {VIEW_TABS.map(({ key, label, Icon }) => (
              <button
                key={key}
                className={`plan-view-btn${view === key ? ' plan-view-btn--active' : ''}`}
                aria-pressed={view === key}
                onClick={() => { updatePreferences({ view: key }); }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {preferenceError != null && <DataNotice title="Plan view could not be remembered or restored" error={preferenceError} />}

      <PlanReviewModal open={reviewOpen} onClose={() => setReviewOpen(false)} />

      <div className="plan-inner">
        <TasksPage
          importOpen={importOpen}
          onImportClose={() => setImportOpen(false)}
          filterProject={filterProject}
          filterTag={filterTag}
          view={view}
          onAskAthena={askAthena}
        />
      </div>
    </div>
  );
};
