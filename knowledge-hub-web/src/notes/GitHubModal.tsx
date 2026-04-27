/**
 * notes/GitHubModal.tsx — confirm + commit message before pushing to GitHub.
 *
 * Carbon APIs confirmed from installed source:
 *   Modal       — open, modalHeading, modalLabel, primaryButtonText, secondaryButtonText,
 *                 onRequestClose, onRequestSubmit, size, children
 *   TextInput   — id (required), labelText (required), value, onChange, placeholder
 *   Button      — used externally to open this modal
 */

import React, { useState } from 'react';
import { Modal, TextInput } from '@carbon/react';
import {
  GITHUB_MODAL_HEADING,
  GITHUB_MODAL_LABEL,
  GITHUB_COMMIT_PLACEHOLDER,
} from './constants';

interface GitHubModalProps {
  open: boolean;
  defaultFilePath: string;
  defaultCommitMessage: string;
  onClose: () => void;
  onConfirm: (filePath: string, commitMessage: string) => void;
}

export const GitHubModal: React.FC<GitHubModalProps> = ({
  open,
  defaultFilePath,
  defaultCommitMessage,
  onClose,
  onConfirm,
}) => {
  const [filePath, setFilePath] = useState(defaultFilePath);
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage);

  function handleSubmit(): void {
    onConfirm(filePath, commitMessage);
  }

  return (
    <Modal
      open={open}
      modalHeading={GITHUB_MODAL_HEADING}
      modalLabel={GITHUB_MODAL_LABEL}
      primaryButtonText="Push"
      secondaryButtonText="Cancel"
      size="sm"
      onRequestClose={onClose}
      onRequestSubmit={handleSubmit}
    >
      <TextInput
        id="github-file-path"
        labelText="File path in repository"
        value={filePath}
        onChange={(e) => { setFilePath(e.target.value); }}
        placeholder="content/blog/my-post.md"
      />
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
