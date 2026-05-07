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
import { Calendar, Dashboard } from '@carbon/icons-react';
import { CalendarPage } from './CalendarPage';
import { TasksPage } from './TasksPage';

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
  const [view, setView] = useState<PlanView>('board');  // default to board

  return (
    <div className="plan-root">
      {/* Shared header */}
      <div className="plan-header page-header">
        <h1 className="page-title">Plan</h1>
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

      {/* Sub-page — .page-header inside is hidden via CSS */}
      <div className="plan-inner">
        {view === 'calendar' && <CalendarPage />}
        {view === 'board'    && <TasksPage />}
      </div>
    </div>
  );
};
