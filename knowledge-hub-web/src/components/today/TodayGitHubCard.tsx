import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Settings } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { GitHubActivityItem, TodayGitHubActivityResponse } from '../../services/api';

const TRIVIAL_RE = /^(merge branch|rename|version bump|\d+\.\d+\.\d+)/i;
const TICKET_RE = /#\d+|PR-\d+/i;

/** Returns true if a commit/PR title is housekeeping noise. */
function isTrivial(title: string): boolean {
  if (TRIVIAL_RE.test(title)) return true;
  const words = title.trim().split(/\s+/);
  return words.length < 3 && !TICKET_RE.test(title);
}

/** Groups mapped activity by project tag then repository. */
function groupByTagAndRepo(items: GitHubActivityItem[]): Map<string, Map<string, GitHubActivityItem[]>> {
  const groups = new Map<string, Map<string, GitHubActivityItem[]>>();
  for (const item of items) {
    const tag = item.project_tag_name;
    const repo = item.repo_full_name || 'Unknown repo';
    if (!groups.has(tag)) groups.set(tag, new Map<string, GitHubActivityItem[]>());
    const byRepo = groups.get(tag);
    if (!byRepo) continue;
    const existing = byRepo.get(repo) ?? [];
    if (existing.length < 5) existing.push(item);
    byRepo.set(repo, existing);
  }
  return groups;
}

/** Compact relative timestamp label. */
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** GitHub activity card grouped by mapped project tag and repository. */
export const TodayGitHubCard: React.FC = () => {
  const query = useQuery({
    queryKey: ['today-github-activity-mapped'],
    queryFn: () => api.getTodayGitHubActivity(),
  });

  const response: TodayGitHubActivityResponse | null =
    query.data?.success === true ? query.data.data : null;
  const hasMappings = response?.hasMappings === true;
  const filtered = useMemo(
    () => (response?.items ?? []).filter((item) => !isTrivial(item.title)),
    [response],
  );
  const grouped = useMemo(() => groupByTagAndRepo(filtered), [filtered]);

  return (
    <div className="today-section-card">
      <div className="today-section-card__header">
        <span className="today-section-card__title">GitHub activity</span>
        <Link className="today-github-settings-link" to="/settings/repo-mappings" title="Manage repo mapping">
          <Settings size={16} />
          Manage repo mapping
        </Link>
      </div>

      {query.isLoading && <p className="today-github-empty">Loading…</p>}

      {!query.isLoading && !hasMappings && (
        <p className="today-github-empty">
          No repos mapped yet. Set up repo-to-project mapping in{' '}
          <Link to="/settings/repo-mappings">settings</Link>.
        </p>
      )}

      {!query.isLoading && hasMappings && grouped.size === 0 && (
        <p className="today-github-empty">No mapped GitHub activity found yet.</p>
      )}

      {Array.from(grouped.entries()).map(([tagName, byRepo]) => (
        <div key={tagName} className="today-github-group">
          <div className="today-github-group__tag">{tagName}</div>
          {Array.from(byRepo.entries()).map(([repo, items]) => (
            <div key={`${tagName}:${repo}`}>
              <div className="today-github-group__repo">{repo}</div>
              {items.map((item) => (
                <div key={item.id} className="today-ranked-row">
                  <div className="today-ranked-row__body">
                    <div className="today-ranked-row__title">
                      {item.url
                        ? <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
                        : item.title}
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
      ))}
    </div>
  );
};
