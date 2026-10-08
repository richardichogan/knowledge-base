/**
 * notes/GitHubModal.tsx — confirm + commit message before pushing to GitHub.
 *
 * Carbon APIs confirmed from installed source:
 *   Modal       — open, modalHeading, modalLabel, primaryButtonText, secondaryButtonText,
 *                 onRequestClose, onRequestSubmit, size, children
 *   TextInput   — id (required), labelText (required), value, onChange, placeholder
 *   Button      — used externally to open this modal
 */

import React, { useEffect, useState } from 'react';
import { Modal, TextInput } from '@carbon/react';
import { api } from '../services/api';
import {
  GITHUB_MODAL_HEADING,
  GITHUB_MODAL_LABEL,
  GITHUB_COMMIT_PLACEHOLDER,
} from './constants';

interface GitHubModalProps {
  open: boolean;
  defaultFilePath: string;
  defaultCommitMessage: string;
  defaultRepo: string;
  onClose: () => void;
  onConfirm: (repo: string, filePath: string, commitMessage: string) => void;
  published?: boolean;
}

export const GitHubModal: React.FC<GitHubModalProps> = ({
  open,
  defaultFilePath,
  defaultCommitMessage,
  defaultRepo,
  onClose,
  onConfirm,
  published = false,
}) => {
  const [filePath, setFilePath] = useState(defaultFilePath);
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);
  const [repo, setRepo] = useState(defaultRepo);
  const [repositories, setRepositories] = useState<{ name: string; defaultBranch: string; private: boolean }[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [repoError, setRepoError] = useState('');
  const [folder, setFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [folderError, setFolderError] = useState('');
  const [folderLoading, setFolderLoading] = useState(false);
  const [branch, setBranch] = useState('');
  useEffect(() => {
    if (open) { setFilePath(defaultFilePath); setCommitMessage(defaultCommitMessage); setRepo(defaultRepo); setFolder(''); setPage(1); setRepositories([]); }
  }, [open, defaultFilePath, defaultCommitMessage, defaultRepo]);
  useEffect(() => {
    if (!open || published) return;
    let cancelled = false;
    setLoading(true);
    setRepoError('');
    void api.getNoteGitHubRepositories(page).then(result => {
      if (!result.success) throw new Error(result.error.message);
      if (cancelled) return;
      setRepositories(current => page === 1 ? result.data.items : [...current, ...result.data.items]);
      setHasMore(result.data.hasMore);
    }).catch((err: unknown) => {
      if (!cancelled) setRepoError(err instanceof Error ? err.message : 'Could not list repositories.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, published, page]);
  useEffect(() => {
    if (!open || !repo || published) return;
    let cancelled = false;
    setFolderLoading(true);
    setFolderError('');
    void api.getNoteGitHubFolders(repo, folder).then(result => {
      if (!result.success) throw new Error(result.error.message);
      if (!cancelled) { setFolders(result.data.folders); setBranch(result.data.branch); }
    }).catch((err: unknown) => {
      if (!cancelled) { setFolders([]); setFolderError(err instanceof Error ? err.message : 'Could not browse this folder.'); }
    }).finally(() => { if (!cancelled) setFolderLoading(false); });
    return () => { cancelled = true; };
  }, [open, repo, folder, published]);

  function chooseFolder(path: string): void {
    setFolder(path);
    setFilePath(`${path ? `${path}/` : ''}${filePath.split('/').at(-1) || 'note.md'}`);
  }

  function handleSubmit(): void {
    onConfirm(repo, filePath, commitMessage);
  }

  return (
    <Modal
      open={open}
      modalHeading={GITHUB_MODAL_HEADING}
      modalLabel={GITHUB_MODAL_LABEL}
      primaryButtonText="Push"
      primaryButtonDisabled={!repo || !filePath.trim() || !commitMessage.trim() || loading || !!repoError}
      secondaryButtonText="Cancel"
      size="sm"
      className="notes-github-modal"
      onRequestClose={onClose}
      onRequestSubmit={handleSubmit}
    >
      <label className="notes-github-repo-label" htmlFor="github-repo">Destination repository</label>
      <select id="github-repo" className="notes-github-select" value={repo} disabled={published || loading}
        onChange={event => { setRepo(event.target.value); setFolder(''); setBranch(''); }}>
        <option value="">Choose a writable repository</option>
        {repo && !repositories.some(item => item.name === repo) && <option value={repo}>{repo}</option>}
        {repositories.map(item => <option key={item.name} value={item.name}>{item.name}{item.private ? ' (private)' : ' (public)'}</option>)}
      </select>
      {loading && <p className="notes-github-help" role="status">Loading repositories...</p>}
      {repoError && <p className="notes-github-error" role="alert">{repoError}</p>}
      {!published && hasMore && <button className="kh-btn-accent notes-github-browse" disabled={loading} onClick={() => { setPage(value => value + 1); }}>Load more repositories</button>}
      {!published && repositories.find(item => item.name === repo)?.private === false &&
        <p className="notes-github-error" role="note">This repository is public. Publishing makes this note readable by anyone.</p>}
      {!published && repo && <div className="notes-github-folder-browser">
        <p className="notes-github-help">Browse: {folder || '/'} {branch && `(branch: ${branch})`}</p>
        {folder && <button className="kh-btn-accent notes-github-browse" disabled={folderLoading}
          onClick={() => { chooseFolder(folder.split('/').slice(0, -1).join('/')); }}>Up one folder</button>}
        <select className="notes-github-select" aria-label="Browse repository folders" value="" disabled={folderLoading}
          onChange={event => { if (event.target.value) chooseFolder(event.target.value); }}>
          <option value="">{folderLoading ? 'Loading folders...' : 'Select a subfolder'}</option>
          {folders.map(path => <option key={path} value={path}>{path.split('/').at(-1)}</option>)}
        </select>
        {folderError && <p className="notes-github-error" role="alert">{folderError}</p>}
      </div>}
      <div className="notes-modal-spacer" />
      <TextInput
        id="github-file-path"
        labelText="File path in repository"
        value={filePath}
        onChange={(e) => { setFilePath(e.target.value); }}
        placeholder="content/notes/my-note.md"
        readOnly={published}
      />
      <p className="notes-github-help">{published
        ? 'This note keeps its linked repository and path. Future saves update the same file.'
        : "Edit the full path to name the file or create a new folder. GitHub uses the selected repo's default branch. Only the Think note is indexed."}</p>
      <div className="notes-modal-spacer" />
      <TextInput
        id="github-commit-msg"
        labelText="Commit message"
        value={commitMessage}
        onChange={(e) => { setCommitMessage(e.target.value); }}
        placeholder={GITHUB_COMMIT_PLACEHOLDER}
      />
    </Modal>
  );
};

export const GitHubConflictModal: React.FC<{
  think: string; github: string | null; busy: boolean;
  onClose: () => void; onConfirm: (choice: 'think' | 'github') => void;
}> = ({ think, github, busy, onClose, onConfirm }) => {
  const [choice, setChoice] = useState<'think' | 'github'>('think');
  return <Modal open size="lg" className="notes-github-modal"
    modalHeading="Choose the note version to keep" modalLabel="GitHub changed"
    primaryButtonText={busy ? 'Applying...' : choice === 'think' ? 'Publish Think version' : 'Accept GitHub version'}
    primaryButtonDisabled={busy} secondaryButtonText="Cancel"
    onRequestClose={() => { if (!busy) onClose(); }}
    onRequestSubmit={() => { onConfirm(choice); }}>
    <p className="notes-github-help">Think remains the master note. Accepting GitHub replaces its writing and keeps the previous writing in History. Publishing Think replaces the reviewed GitHub version.</p>
    <div className="notes-github-versions">
      <label>
        <span><input type="radio" name="github-version" checked={choice === 'think'} disabled={busy} onChange={() => { setChoice('think'); }} /> Think version</span>
        <textarea readOnly value={think} aria-label="Think version" />
      </label>
      <label>
        <span><input type="radio" name="github-version" checked={choice === 'github'} disabled={busy || github === null} onChange={() => { setChoice('github'); }} /> GitHub version</span>
        <textarea readOnly value={github ?? 'This file was deleted on GitHub.'} aria-label="GitHub version" />
      </label>
    </div>
  </Modal>;
};
