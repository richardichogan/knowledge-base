import React from 'react';
import type { DiscoverProjectFit } from '../../services/api';

interface ProjectFitChipsProps {
  fits: DiscoverProjectFit[] | undefined;
  /** Only show projects the article directly serves (compact rows). */
  directOnly?: boolean;
}

/** "Relevant to IMAGINE"-style chips for Discover articles that serve a live project. */
export const ProjectFitChips: React.FC<ProjectFitChipsProps> = ({ fits, directOnly = false }) => {
  const shown = (fits ?? []).filter((f) => !directOnly || f.fit === 2);
  if (shown.length === 0) return null;
  return (
    <div className="dc-project-fit">
      {shown.map((f) => (
        <span
          key={f.projectId}
          className={`dc-project-fit__chip dc-project-fit__chip--${f.fit === 2 ? 'direct' : 'related'}`}
          title={f.why !== '' ? f.why : undefined}
        >
          {f.fit === 2 ? 'Relevant to' : 'Background for'} {f.name}
        </span>
      ))}
    </div>
  );
};
