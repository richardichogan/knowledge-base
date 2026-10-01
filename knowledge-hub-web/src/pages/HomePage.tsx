/**
 * pages/HomePage.tsx — "Today" dashboard.
 * Orchestrates the section cards: Athena's morning briefing, ranked list,
 * GitHub activity, Sparks, and recently-worked-on notes.
 */

import React from 'react';
import { TodayRankedList } from '../components/today/TodayRankedList';
import { TodayBriefingCard } from '../components/today/TodayBriefingCard';
import { TodayGitHubCard } from '../components/today/TodayGitHubCard';
import { TodaySparksCard } from '../components/today/TodaySparksCard';
import { TodayDocumentsCard } from '../components/today/TodayDocumentsCard';

export const HomePage: React.FC = () => {
  return (
    <div className="page-root today-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Today</h1>
          <p className="page-subtitle">What needs your attention.</p>
        </div>
      </div>

      <TodayBriefingCard />
      <TodayRankedList />
      <TodayGitHubCard />
      <TodaySparksCard />
      <TodayDocumentsCard />
    </div>
  );
};
