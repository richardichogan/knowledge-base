/**
 * PlanPage — calendar-first planning hub.
 *
 * Combines Calendar and Board (tasks) into a single page with a view switcher.
 * Each sub-view retains its own data-fetching; only the shared page header
 * and view tabs live here. The inner .page-header of each sub-page is hidden
 * via the .plan-inner wrapper.
 */

import React, { useState } from 'react';
import type { CarbonIconType } from '@carbon/icons-react';
import { Calendar, Dashboard, Upload } from '@carbon/icons-react';
import { Select, SelectItem } from '@carbon/react';
import { CalendarPage } from './CalendarPage';
import { TasksPage } from './TasksPage';
import { useFlatTags } from '../hooks/useTaxonomy';
import { PROJECTS } from '../config/projects';

type PlanView = 'calendar' | 'board';

interface ViewTab {
  key: PlanView;
  label: string;
  Icon: CarbonIconType;
}

const VIEW_TABS: ViewTab[] = [
  { key: 'calendar', label: 'Calendar', Icon: Calendar },
  { key: 'board',    label: 'Board',    Icon: Dashboard },
];

export const PlanPage: React.FC = () => {
  const [view, setView] = useState<PlanView>('board');
  const [importOpen, setImportOpen] = useState(false);
  const [filterProject, setFilterProject] = useState('');
  const [filterTag,     setFilterTag]     = useState('');
  const flatTags = useFlatTags();

  return (
    <div className="plan-root">
      {/* Shared header */}
      <div className="plan-header page-header">
        <h1 className="page-title">Plan</h1>
        <div className="plan-header__right">
          {view === 'board' && (
            <>
              <Select id="plan-filter-project" labelText="" hideLabel size="sm"
                value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
                <SelectItem value="" text="All projects" />
                {PROJECTS.map((p) => <SelectItem key={p.id} value={p.id} text={p.name} />)}
              </Select>
              <Select id="plan-filter-tag" labelText="" hideLabel size="sm"
                value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
                <SelectItem value="" text="All tags" />
                {flatTags.map((t) => <SelectItem key={t.id} value={t.id} text={t.name} />)}
              </Select>
              <button
                type="button"
                className="kb-import-btn"
                onClick={() => setImportOpen(true)}
                title="Import tasks from a podcast episode"
              >
                <Upload size={16} /> Import episode
              </button>
            </>
          )}
          <div className="plan-view-toggle">
            {VIEW_TABS.map(({ key, label, Icon }) => (
              <button
                key={key}
                className={`plan-view-btn${view === key ? ' plan-view-btn--active' : ''}`}
                onClick={() => { setView(key); }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Sub-page — .page-header inside is hidden via CSS */}
      <div className="plan-inner">
        {view === 'calendar' && <CalendarPage />}
        {view === 'board'    && (
          <TasksPage
            onImportOpen={() => setImportOpen(true)}
            importOpen={importOpen}
            onImportClose={() => setImportOpen(false)}
            filterProject={filterProject}
            filterTag={filterTag}
          />
        )}
      </div>
    </div>
  );
};
