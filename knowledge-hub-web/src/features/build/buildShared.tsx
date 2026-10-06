/**
 * features/build/buildShared.tsx — helpers shared by the Build page and the
 * "Send to Build" entry points on Think notes and Athena outputs.
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { api, type BuildSpecWithTasks } from '../../services/api';
import type { ApiResponse } from '../../types/apiResponse';

const REPO_LIST_STALE_MS = 5 * 60_000;

export function describeBuildError(err: unknown): string {
  if (isAxiosError(err)) {
    const body = err.response?.data as { error?: { message?: unknown } } | undefined;
    return typeof body?.error?.message === 'string' ? body.error.message : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function unwrap<T>(r: ApiResponse<T>): T {
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

/** GitHub repos already connected to Knowledge Hub — offered as suggestions. */
export function useGithubRepos(): string[] {
  const { data = [] } = useQuery({
    queryKey: ['build-repos'],
    queryFn: async () => {
      const r = await api.getRepoProjectMappingConfig();
      return r.success ? r.data.repos.filter((x) => x.provider === 'github').map((x) => x.repoFullName) : [];
    },
    staleTime: REPO_LIST_STALE_MS,
  });
  return data;
}

export const RepoField: React.FC<{ value: string; repos: string[]; onChange: (v: string) => void; disabled?: boolean; listId?: string }> = ({
  value, repos, onChange, disabled = false, listId = 'build-repo-options',
}) => (
  <label className="build-field">
    <span className="build-field__label">Repository</span>
    <input className="build-input" list={listId} value={value} placeholder="owner/name" disabled={disabled}
      onChange={(e) => { onChange(e.target.value.trim()); }} />
    <datalist id={listId}>{repos.map((r) => <option key={r} value={r} />)}</datalist>
  </label>
);

type Source = { kind: 'note'; noteId: string } | { kind: 'output'; outputId: string };

/** Asks which repo to build in, creates the spec, then opens it on the Build page. */
export const SendToBuildDialog: React.FC<{ source: Source; onClose: () => void }> = ({ source, onClose }) => {
  const repos = useGithubRepos();
  const navigate = useNavigate();
  const [repo, setRepo] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = (): void => {
    setBusy(true); setError(null);
    const branch = baseBranch.trim() !== '' ? { baseBranch: baseBranch.trim() } : {};
    const req: Promise<ApiResponse<BuildSpecWithTasks>> = source.kind === 'note'
      ? api.createBuildSpecFromNote({ noteId: source.noteId, repo, ...branch })
      : api.createBuildSpecFromOutput({ outputId: source.outputId, repo, ...branch });
    void req.then((r) => { const spec = unwrap(r); onClose(); navigate(`/build?spec=${spec.id}`); })
      .catch((e: unknown) => { setError(describeBuildError(e)); })
      .finally(() => { setBusy(false); });
  };

  // Portalled so it isn't clipped by the Athena side panel's containing block.
  return createPortal(
    <div className="docs-upload-dialog-overlay" role="presentation" onClick={onClose}>
      <div className="docs-upload-dialog build-send-dialog" role="dialog" aria-modal="true" aria-labelledby="build-send-title"
        onClick={(e) => { e.stopPropagation(); }}>
        <h2 id="build-send-title" className="docs-upload-dialog__title">Send to Build</h2>
        <p className="docs-upload-dialog__subtitle">
          Creates a build spec from this {source.kind === 'note' ? 'note' : 'output'}. You can review it and decompose it into agent tasks before anything is sent to GitHub.
        </p>
        <div className="build-send-dialog__fields">
          <RepoField value={repo} repos={repos} onChange={setRepo} listId="build-send-repo-options" />
          <label className="build-field">
            <span className="build-field__label">Base branch</span>
            <input className="build-input" value={baseBranch} placeholder="main" onChange={(e) => { setBaseBranch(e.target.value); }} />
          </label>
        </div>
        {error !== null && <p className="build-error">{error}</p>}
        <div className="build-row build-send-dialog__actions">
          <button type="button" className="kb-import-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="docs-upload-btn" disabled={busy || repo === ''} onClick={send}>{busy ? 'Creating…' : 'Create spec'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
