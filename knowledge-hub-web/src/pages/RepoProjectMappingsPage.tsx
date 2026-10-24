import React, { useMemo, useState } from 'react';
import { Button, Dropdown, InlineLoading } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import type { RepoProjectMappingConfig } from '../services/api';
import { PageHeader } from '../components/PageHeader';

interface TagOption {
  id: string | null;
  label: string;
}

const UNMAPPED_OPTION: TagOption = { id: null, label: 'Unmapped' };

/** Build dropdown options from filing tags in config payload. */
function buildTagOptions(config: RepoProjectMappingConfig | null): TagOption[] {
  const options: TagOption[] = [UNMAPPED_OPTION];
  for (const t of config?.filingTags ?? []) {
    options.push({ id: t.id, label: t.parentName ? `${t.parentName} / ${t.name}` : t.name });
  }
  return options;
}

/** Repo-to-project mapping settings screen for Today GitHub card grouping. */
export const RepoProjectMappingsPage: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const queryClient = useQueryClient();
  const [selectedByRepo, setSelectedByRepo] = useState<Record<string, string | null>>({});
  const configQuery = useQuery({
    queryKey: ['repo-project-mapping-config'],
    queryFn: () => api.getRepoProjectMappingConfig(),
  });

  const saveMutation = useMutation({
    mutationFn: ({ repoFullName, projectTagId }: { repoFullName: string; projectTagId: string | null }) =>
      api.saveRepoProjectMapping(repoFullName, projectTagId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['repo-project-mapping-config'] });
      void queryClient.invalidateQueries({ queryKey: ['today-github-activity-mapped'] });
    },
  });

  const config = configQuery.data?.success === true ? configQuery.data.data : null;
  const options = useMemo(() => buildTagOptions(config), [config]);
  const mappingMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const m of config?.mappings ?? []) map.set(m.repoFullName, m.projectTagId);
    return map;
  }, [config]);

  function selectedTag(repoFullName: string): string | null {
    return selectedByRepo[repoFullName] !== undefined
      ? selectedByRepo[repoFullName]
      : (mappingMap.get(repoFullName) ?? null);
  }

  return (
    <main className="page-root today-settings-page">
      {!embedded && <PageHeader title="Manage repo mapping" subtitle="Map each connected repo/path to a filing project tag." actions={
        <Link className="today-settings-page__back" to="/">Back to Today</Link>
      } />}
      {embedded && <p className="kh-settings-description">Map each connected repo/path to a filing project tag.</p>}

      <div className="today-section-card">
        <div className="today-section-card__header">
          <span className="today-section-card__title">Repo → project mappings</span>
        </div>

        {configQuery.isLoading && <InlineLoading description="Loading repo mappings…" className="kh-loading-inset" />}

        {!configQuery.isLoading && (config?.repos.length ?? 0) === 0 && (
          <p className="today-github-empty">No connected repos found in current sync configuration.</p>
        )}

        {(config?.repos ?? []).map((repo) => {
          const initial = mappingMap.get(repo.repoFullName) ?? null;
          const current = selectedTag(repo.repoFullName);
          const changed = current !== initial;
          const selectedOption = options.find((opt) => opt.id === current) ?? UNMAPPED_OPTION;
          return (
            <div key={`${repo.provider}:${repo.repoFullName}`} className="today-repo-map-row">
              <div className="today-repo-map-row__repo">
                <span className={`today-repo-map-row__provider today-repo-map-row__provider--${repo.provider}`}>
                  {repo.provider}
                </span>
                <span className="today-repo-map-row__name">{repo.repoFullName}</span>
              </div>

              <div className="today-repo-map-row__selector">
                <Dropdown<TagOption>
                  id={`repo-map-${repo.provider}-${repo.repoFullName.replace(/[^\w-]/g, '-')}`}
                  titleText=""
                  label="Select filing tag"
                  items={options}
                  selectedItem={selectedOption}
                  itemToString={(item) => item?.label ?? ''}
                  onChange={({ selectedItem }) => {
                    setSelectedByRepo((prev) => ({ ...prev, [repo.repoFullName]: selectedItem?.id ?? null }));
                  }}
                  size="sm"
                />
              </div>

              <div className="today-repo-map-row__state">{current === null ? 'Unmapped' : 'Mapped'}</div>

              <Button
                kind="primary"
                size="sm"
                disabled={!changed || saveMutation.isPending}
                onClick={() => {
                  void saveMutation.mutateAsync({ repoFullName: repo.repoFullName, projectTagId: current });
                }}
              >
                Save
              </Button>
            </div>
          );
        })}
      </div>
    </main>
  );
};
