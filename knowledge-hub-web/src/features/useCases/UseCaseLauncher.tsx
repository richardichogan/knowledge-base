/**
 * UseCaseLauncher — the "→ Use case" action wherever an idea lives (Discover, Sparks,
 * Think notes, canvases). Opens CreateUseCaseDialog seeded with the item, then confirms
 * in place with a link to Plan so triage is not interrupted.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppDialog } from '../../components/AppDialog';
import type { UseCaseDetail, UseCaseSourceRef } from '../../types/useCases';
import { CreateUseCaseDialog } from './CreateUseCaseDialog';

export interface UseCaseLaunch {
  title: string;
  sources: UseCaseSourceRef[];
  /** e.g. "Discover item “Agentic claims”" */
  sourceLabel: string;
  projectId?: string | null;
}

export function hrefForUseCase(id: string): string {
  return `/plan?view=use-cases&useCase=${encodeURIComponent(id)}`;
}

export const UseCaseLauncher: React.FC<{ launch: UseCaseLaunch; onClose: () => void }> = ({ launch, onClose }) => {
  const [done, setDone] = useState<UseCaseDetail | null>(null);

  if (done !== null) {
    return (
      <AppDialog key="done" title="Use case saved" onClose={onClose} actions={<>
        <button type="button" className="kh-btn-ghost" onClick={onClose} data-dialog-autofocus>Done</button>
        <Link className="kh-btn-accent" to={hrefForUseCase(done.id)} onClick={onClose}>Open in Plan</Link>
      </>}>
        <p className="kh-uc-handoff__lead">
          {launch.sourceLabel} is in <strong>{done.title}</strong> ({done.sources.length === 1 ? '1 source' : `${done.sources.length.toString()} sources`}).
        </p>
      </AppDialog>
    );
  }

  return (
    <CreateUseCaseDialog key="form" onClose={onClose} onCreated={setDone} initialTitle={launch.title}
      initialProjectId={launch.projectId ?? null} sources={launch.sources} sourceLabel={launch.sourceLabel} />
  );
};
