/**
 * components/tags/MergeSuggestionModal.tsx
 * Modal to merge a pending suggestion into an existing tag.
 */
import React, { useState } from 'react';
import { Modal, InlineNotification } from '@carbon/react';
import { TagPicker } from '../TagPicker';
import { api } from '../../services/api';

interface Props {
  open: boolean;
  suggestionId: string;
  suggestionName: string;
  onClose: () => void;
  onDone: () => void;
}

export const MergeSuggestionModal: React.FC<Props> = ({
  open, suggestionId, suggestionName, onClose, onDone,
}) => {
  const [mergeToId, setMergeToId] = useState<string>('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    if (!mergeToId) { setError('Select a tag to merge into'); return; }
    setSaving(true);
    setError(null);
    try {
      await api.mergeTagSuggestion(suggestionId, mergeToId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to merge');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      modalHeading={`Merge "${suggestionName}" into…`}
      primaryButtonText={saving ? 'Saving…' : 'Merge'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving || !mergeToId}
      onRequestClose={onClose}
      onRequestSubmit={() => { void handleSubmit(); }}
      onSecondarySubmit={onClose}
      size="sm"
    >
      <div className="tag-suggestion-modal__body">
        {error && <InlineNotification kind="error" title={error} lowContrast hideCloseButton />}
        <p className="tag-suggestion-modal__label">Select the existing tag this should map to:</p>
        <TagPicker
          selectedIds={mergeToId ? [mergeToId] : []}
          onChange={(ids) => setMergeToId(ids[ids.length - 1] ?? '')}
          trigger={<button type="button" className="notes-tag-picker-trigger">{mergeToId ? '✓ Tag selected — change' : '+ Pick tag'}</button>}
        />
      </div>
    </Modal>
  );
};
