/**
 * components/today/TodayGitHubCard.tsx
 * GitHub activity filtered by user-selected project taxonomy tags.
 * Tag selection is persisted to localStorage; default = Imagine tag.
 */

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Settings } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { GitHubActivityItem } from '../../services/api';
import { TagPicker } from '../TagPicker';

const LS_KEY = 'kh-github-tag-filter';
const DEFAULT_TAG_IDS = ['793b0516-50ff-4d04-aa07-c11d47149709'];
const TRIVIAL_RE = /^(merge branch|rename|version bump|\d+\.\d+\.\d+)/i;
const TICKET_RE = /#\d+|PR-\d+/i;

function loadTagIds(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* ignore */ }
  return DEFAULT_TAG_IDS;
}

function saveTagIds(ids: string[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
}

/** Returns true if the commit/item title should be filtered out as noise. */
function isTrivial(title: string): boolean {
  if (TRIVIAL_RE.test(title)) return true;
  const words = title.trim().split(/\s+/);
  if (words.length < 3 && !TICKET_RE.test(title)) return true;
  return false;
}

/** Extract repo name from GitHub item metadata or title prefix. */
function extractRepo(item: GitHubActivityItem): string {
  const meta = item.metadata;
  if (meta && typeof meta['repository'] === 'string') return meta['repository'] as string;
  const match = /^([^/:]+\/[^/:]+)/.exec(item.title);
  return match ? match[1] ?? 'Unknown repo' : 'Unknown repo';
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

interface RepoGroup { repo: string; items: GitHubActivityItem[]; }

function groupByRepo(items: GitHubActivityItem[]): RepoGroup[] {
  const map = new Map<string, GitHubActivityItem[]>();
  for (const item of items) {
    const repo = extractRepo(item);
    const existing = map.get(repo) ?? [];
    if (existing.length < 5) {
      existing.push(item);
      map.set(repo, existing);
    }
  }
  return Array.from(map.entries()).map(([repo, its]) => ({ repo, items: its }));
}

/** GitHub activity card with tag-filter picker. */
export const TodayGitHubCard: React.FC = () => {
  const [tagIds, setTagIds] = useState<string[]>(loadTagIds);

  function handleTagChange(ids: string[]): void {
    setTagIds(ids);
    saveTagIds(ids);
  }

  const query = useQuery({
    queryKey: ['today-github-activity', tagIds],
    queryFn: () => api.getTodayGitHubActivity(tagIds),
    enabled: tagIds.length > 0,
  });

  const rawItems: GitHubActivityItem[] =
    query.data?.success === true ? (query.data.data as GitHubActivityItem[]) : [];

  const filteredItems = useMemo(
    () => rawItems.filter((i) => !isTrivial(i.title)),
    [rawItems],
  );

  const groups = useMemo(() => groupByRepo(filteredItems), [filteredItems]);

  return (
    <div className="today-section-card">
      <div className="today-section-card__header">
        <span className="today-section-card__title">GitHub activity</span>
        <TagPicker
          selectedIds={tagIds}
          onChange={handleTagChange}
          trigger={
            <button className="dc-action dc-action--icon" title="Filter by project tags">
              <Settings size={16} />
            </button>
          }
        />
      </div>

      {query.isLoading && (
        <p style={{ padding: '12px 16px', fontSize: 13, color: 'var(--cds-text-secondary)', margin: 0 }}>
          Loading…
        </p>
      )}

      {!query.isLoading && tagIds.length === 0 && (
        <p className="today-github-empty">
          No project tags selected. Use ⚙ to configure project tags.
        </p>
      )}

      {!query.isLoading && tagIds.length > 0 && groups.length === 0 && (
        <p className="today-github-empty">
          No tagged GitHub activity found. Use ⚙ to configure project tags.
        </p>
      )}

      {groups.map(({ repo, items }) => (
        <div key={repo} className="today-github-group">
          <div className="today-github-group__repo">{repo}</div>
          {items.map((item) => (
            <div key={item.id} className="today-ranked-row">
              <div className="today-ranked-row__body">
                <div className="today-ranked-row__title">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                      {item.title}
                    </a>
                  ) : item.title}
                </div>
                <div className="today-ranked-row__context">
                  {item.source.replace('github-', '')} · {timeAgo(item.published_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};
