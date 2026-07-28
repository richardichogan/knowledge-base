/**
 * pages/HomePage.tsx — "Today" dashboard.
 * Orchestrates the four section cards: ranked list, GitHub activity,
 * Sparks, and recently-worked-on notes.
 */

import React, { useState } from 'react';
import { TodayRankedList } from '../components/today/TodayRankedList';
import { TodayGitHubCard } from '../components/today/TodayGitHubCard';
import { TodaySparksCard } from '../components/today/TodaySparksCard';
import { TodayDocumentsCard } from '../components/today/TodayDocumentsCard';

export const HomePage: React.FC = () => {
  const [rankedClusterIds, setRankedClusterIds] = useState<string[]>([]);

  return (
    <div className="page-root today-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Today</h1>
          <p className="page-subtitle">What needs your attention.</p>
        </div>
      </div>

      <TodayRankedList onRankedClusterIds={setRankedClusterIds} />
      <TodayGitHubCard />
      <TodaySparksCard rankedClusterIds={rankedClusterIds} />
      <TodayDocumentsCard />
    </div>
  );
};

