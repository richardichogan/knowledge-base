/**
 * CalendarPage — 7-day calendar view.
 * Forward-looking days show calendar events and tasks.
 * Historical days add blog/podcast cards, GitHub/GitLab repo summaries, and notes.
 *
 * Component APIs confirmed via Carbon source declarations:
 *   Grid        — fullWidth?, narrow?, condensed?, children
 *   Column      — lg?, md?, sm?, span?, className?, children
 *   Tag         — type ('blue'|'cyan'|'teal'|'purple'|'green'|'magenta'|'red'|'gray'|...), size ('sm'|'md'|'lg'), children
 *   ClickableTile — href?, rel?, onClick?, disabled?, children, className?
 *   Button      — kind ('primary'|'secondary'|'ghost'|'tertiary'|...), size ('xs'|'sm'|'md'|'lg'|'xl'|'2xl'), renderIcon?, iconDescription?, onClick?, disabled?, children
 *   IconButton  — label (required), kind ('primary'|'secondary'|'ghost'|'tertiary'), size ('xs'|'sm'|'md'|'lg'), disabled?, onClick?, children (icon)
 */

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  InlineLoading,
  InlineNotification,
  Tag,
  ClickableTile,
  Button,
  IconButton,
} from '@carbon/react';
import { ChevronLeft, ChevronRight } from '@carbon/icons-react';
import { api } from '../services/api';
import type { ContentItemSummary } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

type TagType = 'blue' | 'cyan' | 'teal' | 'purple' | 'green' | 'magenta' | 'red' | 'gray' | 'warm-gray';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" string from any ISO string */
function toDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/** "Mon 13" */
function formatColHeader(date: Date): string {
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
}

/** "Mon 13 Apr — Sun 19 Apr" */
function formatWindowLabel(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
  return `${start.toLocaleDateString('en-GB', opts)} — ${end.toLocaleDateString('en-GB', opts)}`;
}

/** "HH:MM" */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Return the Monday of the week containing `date` (local time). */
function weekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Add `n` days to `date` (clone). */
function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Extract a "repo" identifier from a GitHub/GitLab item title or tags. */
function extractRepo(item: ContentItemSummary): string {
  // Check metadata first
  if (item.metadata?.repo) return item.metadata.repo as string;
  if (item.metadata?.repoFullName) return item.metadata.repoFullName as string;
  if (item.metadata?.projectPath) return item.metadata.projectPath as string;
  
  // tags may contain "owner/repo"
  const repoTag = item.tags?.find((t) => t.includes('/'));
  if (repoTag !== undefined) return repoTag;
  
  // fallback: first segment of title after ' — '
  const dash = item.title.indexOf(' — ');
  if (dash > 0) return item.title.slice(dash + 3);
  
  return 'unknown-repo';
}

/** Build a GitHub compare URL for a repo on a given date. */
function githubDateUrl(repo: string, dateKey: string): string {
  return `https://github.com/${repo}/commits?since=${dateKey}T00:00:00Z&until=${dateKey}T23:59:59Z`;
}

/** Build a GitLab compare URL for a repo on a given date. */
function gitlabDateUrl(repo: string, dateKey: string): string {
  return `https://gitlab.com/${repo}/-/commits/main?after=${dateKey}&before=${addDays(new Date(dateKey), 1).toISOString().slice(0, 10)}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface ItemCardProps {
  tag: string;
  tagType: TagType;
  title: string;
  subtitle?: string | undefined;
  href?: string | undefined;
}

const ItemCard: React.FC<ItemCardProps> = ({ tag, tagType, title, subtitle, href }) => (
  <ClickableTile
    href={href ?? '#'}
    rel="noreferrer"
    className={`c7-card c7-card--${tagType}`}
  >
    <div className="c7-card__header">
      <Tag type={tagType} size="sm">{tag}</Tag>
      {subtitle !== undefined && subtitle !== '' && (
        <span className="c7-card__time">{subtitle}</span>
      )}
    </div>
    <p className="c7-card__title">{title}</p>
  </ClickableTile>
);

// ── Day column ────────────────────────────────────────────────────────────────

interface DayColProps {
  date: Date;
  todayKey: string;
  items: ContentItemSummary[];
}

const DayCol: React.FC<DayColProps> = ({ date, todayKey, items }) => {
  const dateKey = toDateKey(date.toISOString());
  const isToday = dateKey === todayKey;
  const isPast = dateKey < todayKey;

  // Forward-looking: calendar events + tasks only
  const calItems = items.filter((i) => i.source === 'graph-calendar');
  const taskItems = items.filter((i) => i.source === 'graph-todo');

  // Historical extras (no commits — those belong in My Work)
  const blogItems = items.filter((i) => i.source === 'cms-blog' || i.source === 'cms-newsletter');
  const podcastItems = items.filter((i) => i.source === 'cms-podcast-show-notes');
  const noteItems = items.filter((i) => i.source === 'note');

  const calendarOnlyItems = [...calItems, ...taskItems, ...blogItems, ...podcastItems, ...noteItems];
  const hasAnyActivity = calendarOnlyItems.length > 0;
  const hasForward = calItems.length > 0 || taskItems.length > 0;

  return (
    <div className={`c7-day-col${isToday ? ' c7-day-col--today' : ''}`}>
      {/* Column header — matches kanban col__head style */}
      <div className={`c7-day-header${isToday ? ' c7-day-header--today' : ''}`}>
        <span className="c7-day-name">{formatColHeader(date)}</span>
        <span className="c7-day-count">
          {isToday && <span className="c7-today-badge">Today</span>}
          {items.length > 0 && <span className="c7-day-num">{items.length}</span>}
        </span>
      </div>

      {/* Cards */}
      <div className="c7-day-body">
        {/* Calendar events (always shown) */}
        {calItems.map((item) => (
          <ItemCard
            key={item.id}
            tag="Calendar"
            tagType="blue"
            title={item.title}
            subtitle={formatTime(item.publishedAt)}
            {...(item.url != null && { href: item.url })}
          />
        ))}

        {/* Tasks (always shown) */}
        {taskItems.map((item) => {
          const isOverdue = item.publishedAt < todayKey && item.source === 'graph-todo';
          return (
            <ItemCard
              key={item.id}
              tag="Task"
              tagType={isOverdue ? 'red' : 'purple'}
              title={item.title}
              subtitle={formatTime(item.publishedAt)}
              {...(item.url != null && { href: item.url })}
            />
          );
        })}

        {/* Historical extras */}
        {isPast && (
          <>
            {blogItems.map((item) => (
              <ItemCard
                key={item.id}
                tag={item.source === 'cms-blog' ? 'Blog' : 'Newsletter'}
                tagType="green"
                title={item.title}
                subtitle={formatTime(item.publishedAt)}
                {...(item.url != null && { href: item.url })}
              />
            ))}

            {podcastItems.map((item) => (
              <ItemCard
                key={item.id}
                tag="Podcast"
                tagType="teal"
                title={item.title}
                subtitle={formatTime(item.publishedAt)}
                {...(item.url != null && { href: item.url })}
              />
            ))}

            {noteItems.map((item) => (
              <ItemCard
                key={item.id}
                tag="Note"
                tagType="gray"
                title={item.title}
                {...(item.url != null && { href: item.url })}
              />
            ))}
          </>
        )}

        {/* Empty states */}
        {!isPast && !hasForward && (
          <p className="c7-empty">Nothing scheduled</p>
        )}
        {isPast && !hasAnyActivity && (
          <p className="c7-empty">No activity</p>
        )}
      </div>
    </div>
  );
};

// ── Page component ────────────────────────────────────────────────────────────

export const CalendarPage: React.FC = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = toDateKey(today.toISOString());

  // windowStart is the Monday of the displayed week, offset by weekOffset * 7 days
  const [weekOffset, setWeekOffset] = useState(0);
  const windowStart = addDays(weekStart(today), weekOffset * 7);
  const windowEnd = addDays(windowStart, 6);

  // Build the 7 day Date objects
  const days: Date[] = Array.from({ length: 7 }, (_, i) => addDays(windowStart, i));

  // Date range strings for query key (to refetch when window changes)
  const rangeStart = toDateKey(windowStart.toISOString());
  const rangeEnd = toDateKey(windowEnd.toISOString());

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['calendar-week', rangeStart, rangeEnd],
    queryFn: () => api.getTimeline({ pageSize: 100 }),
    staleTime: 5 * 60_000,
  });

  if (isPending && !isError) return <InlineLoading description="Loading calendar…" />;
  if (isError) return (
    <InlineNotification kind="error" title="Error" subtitle={String(error)} lowContrast />
  );
  if (!data.success) return (
    <InlineNotification kind="error" title="Error" subtitle={data.error.message} lowContrast />
  );

  // Index items by date key, filtered to the visible 7-day window
  const byDay = new Map<string, ContentItemSummary[]>();
  for (const item of data.data.items) {
    const key = toDateKey(item.publishedAt);
    if (key < rangeStart || key > rangeEnd) continue;
    const existing = byDay.get(key) ?? [];
    existing.push(item);
    byDay.set(key, existing);
  }

  return (
    <div className="page-root c7-root">
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Calendar</h1>
          <p className="page-subtitle">{formatWindowLabel(windowStart, windowEnd)}</p>
        </div>
        <div className="page-controls">
          <IconButton
            label="Previous week"
            kind="ghost"
            size="sm"
            onClick={() => { setWeekOffset((n) => n - 1); }}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label="Next week"
            kind="ghost"
            size="sm"
            onClick={() => { setWeekOffset((n) => n + 1); }}
          >
            <ChevronRight />
          </IconButton>
          {weekOffset !== 0 && (
            <Button
              kind="ghost"
              size="sm"
              onClick={() => { setWeekOffset(0); }}
            >
              Today
            </Button>
          )}
        </div>
      </div>

      {/* 7-column grid */}
      <div className="c7-grid">
        {days.map((day) => {
          const key = toDateKey(day.toISOString());
          return (
            <DayCol
              key={key}
              date={day}
              todayKey={todayKey}
              items={byDay.get(key) ?? []}
            />
          );
        })}
      </div>
    </div>
  );
};
