/**
 * HomePage — the "Today" landing page.
 *
 * A lightweight cross-cutting rollup, not a second copy of any existing
 * page: each section teases a handful of items from Plan (due tasks),
 * My Work (GitHub activity), Discover (to-review queue) and Think (recent
 * notes), then links through to the real page for the full list. Exists to
 * answer "what needs my attention right now" in one glance, which no single
 * existing page currently does — Discover only surfaces news articles.
 */

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { InlineLoading } from '@carbon/react';
import {
  CheckmarkOutline,
  LogoGithub,
  Compass,
  Notebook,
  ArrowRight,
  WarningAltFilled,
} from '@carbon/icons-react';
import type { CarbonIconType } from '@carbon/icons-react';
import { api, type DiscoverItem } from '../services/api';
import type { ContentItemSummary } from '../types';
import { fetchNotes } from '../notes/noteStorage';
import type { NoteListItem } from '../notes/types';

type TaskStatus = 'backlog' | 'in-progress' | 'blocked' | 'awaiting-feedback' | 'completed';
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  projectId: string;
}

// Fetched as three separate small requests (rather than one shared "latest
// 30 across all sources" call) because github-* items are a small minority
// of total content volume — a single shared page can easily come back with
// zero or one GitHub item even when there's plenty of recent activity.
const GITHUB_SOURCES = ['github-commit', 'github-pr', 'github-issue'] as const;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Compact relative label ("2h ago", "3d ago") — same rules as the chat
// sidebar's formatSessionTime, duplicated locally to keep this page
// self-contained rather than reaching into AIChatPage internals.
function timeAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.round(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDueDate(iso: string): string {
  const today = todayStr();
  if (iso < today) return 'Overdue';
  if (iso === today) return 'Due today';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface HomeSectionProps {
  title: string;
  Icon: CarbonIconType;
  viewAllHref: string;
  isLoading: boolean;
  isEmpty: boolean;
  emptyLabel: string;
  children?: React.ReactNode;
}

const HomeSection: React.FC<HomeSectionProps> = ({
  title, Icon, viewAllHref, isLoading, isEmpty, emptyLabel, children,
}) => (
  <section className="today-card">
    <div className="today-card__header">
      <div className="today-card__title">
        <Icon size={18} className="today-card__icon" />
        <span>{title}</span>
      </div>
      <Link to={viewAllHref} className="today-card__view-all">
        View all <ArrowRight size={14} />
      </Link>
    </div>
    <div className="today-card__body">
      {isLoading && <InlineLoading description="Loading…" />}
      {!isLoading && isEmpty && <p className="today-card__empty">{emptyLabel}</p>}
      {!isLoading && !isEmpty && children}
    </div>
  </section>
);

export const HomePage: React.FC = () => {
  const tasksQuery = useQuery({
    queryKey: ['home-tasks'],
    queryFn: () => api.getTasks(),
  });
  // One request per GitHub source so a low-volume source can't get crowded
  // out of a single shared "latest N" page — see comment on GITHUB_SOURCES.
  const githubQuery = useQuery({
    queryKey: ['home-github-activity'],
    queryFn: () => Promise.all(
      GITHUB_SOURCES.map((source) => api.getTimeline({ source, page: 1, pageSize: 5 })),
    ),
  });
  const discoverQuery = useQuery({
    queryKey: ['home-discover'],
    queryFn: () => api.getDiscoverFeed('to-review', undefined, 1, 5),
  });
  const notesQuery = useQuery({
    queryKey: ['home-notes'],
    queryFn: () => fetchNotes(),
  });

  const allTasks: Task[] =
    tasksQuery.data?.success === true
      ? ((tasksQuery.data.data as { items: Task[] }).items ?? [])
      : [];
  const today = todayStr();
  const dueTasks = allTasks
    .filter((t) => t.status !== 'completed' && t.dueDate !== null && t.dueDate <= today)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    .slice(0, 5);

  const githubActivity: ContentItemSummary[] = (githubQuery.data ?? [])
    .flatMap((res) => (res.success ? res.data.items : []))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 5);

  const discoverItems: DiscoverItem[] =
    discoverQuery.data?.success === true ? discoverQuery.data.data.items : [];

  const recentNotes: NoteListItem[] = (notesQuery.data ?? [])
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);


  return (
    <div className="page-root today-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Today</h1>
          <p className="page-subtitle">What needs your attention across the hub.</p>
        </div>
      </div>

      <div className="today-grid">
        <HomeSection
          title="Due & overdue tasks"
          Icon={CheckmarkOutline}
          viewAllHref="/plan"
          isLoading={tasksQuery.isLoading}
          isEmpty={dueTasks.length === 0}
          emptyLabel="Nothing due — you're all caught up."
        >
          <ul className="today-list">
            {dueTasks.map((t) => (
              <li key={t.id} className="today-list__item">
                <span className="today-list__title">{t.title}</span>
                <span className={t.dueDate !== null && t.dueDate < today ? 'today-list__badge today-list__badge--overdue' : 'today-list__badge'}>
                  {t.dueDate !== null && t.dueDate < today && <WarningAltFilled size={12} />}
                  {t.dueDate !== null ? formatDueDate(t.dueDate) : ''}
                </span>
              </li>
            ))}
          </ul>
        </HomeSection>

        <HomeSection
          title="Recent GitHub activity"
          Icon={LogoGithub}
          viewAllHref="/my-work"
          isLoading={githubQuery.isLoading}
          isEmpty={githubActivity.length === 0}
          emptyLabel="No recent GitHub activity."
        >
          <ul className="today-list">
            {githubActivity.map((item) => (
              <li key={item.id} className="today-list__item">
                <span className="today-list__title">{item.title}</span>
                <span className="today-list__meta">{timeAgo(item.publishedAt)}</span>
              </li>
            ))}
          </ul>
        </HomeSection>

        <HomeSection
          title="To review"
          Icon={Compass}
          viewAllHref="/discover"
          isLoading={discoverQuery.isLoading}
          isEmpty={discoverItems.length === 0}
          emptyLabel="Nothing new to review."
        >
          <ul className="today-list">
            {discoverItems.map((item) => (
              <li key={item.id} className="today-list__item">
                <span className="today-list__title">{item.title}</span>
                <span className="today-list__meta">{item.sourceTitle}</span>
              </li>
            ))}
          </ul>
        </HomeSection>

        <HomeSection
          title="Recently updated notes"
          Icon={Notebook}
          viewAllHref="/think"
          isLoading={notesQuery.isLoading}
          isEmpty={recentNotes.length === 0}
          emptyLabel="No notes yet."
        >
          <ul className="today-list">
            {recentNotes.map((n) => (
              <li key={n.id} className="today-list__item">
                <span className="today-list__title">{n.title || 'Untitled note'}</span>
                <span className="today-list__meta">{timeAgo(n.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </HomeSection>
      </div>
    </div>
  );
};
