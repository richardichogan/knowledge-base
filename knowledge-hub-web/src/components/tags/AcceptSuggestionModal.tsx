/**
 * components/tags/AcceptSuggestionModal.tsx
 * Modal to accept a pending tag suggestion — user picks a parent then confirms.
 */
import React, { useState } from 'react';
import { Modal, Select, SelectItem, InlineNotification } from '@carbon/react';
import { useTaxonomy } from '../../hooks/useTaxonomy';
import { api } from '../../services/api';

interface Props {
  open: boolean;
  suggestionId: string;
  suggestionName: string;
  onClose: () => void;
  onDone: () => void;
}

export const AcceptSuggestionModal: React.FC<Props> = ({
  open, suggestionId, suggestionName, onClose, onDone,
}) => {
  const { data: parents = [] } = useTaxonomy();
  const [parentId, setParentId] = useState<string>('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const parentOptions = parents.filter((p) => p.children?.length !== undefined);

  const handleSubmit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.acceptTagSuggestion(suggestionId, parentId || null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to accept suggestion');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      modalHeading={`Accept "${suggestionName}"`}
      primaryButtonText={saving ? 'Saving…' : 'Accept & create tag'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestClose={onClose}
      onRequestSubmit={() => { void handleSubmit(); }}
      onSecondarySubmit={onClose}
      size="sm"
    >
      <div className="tag-suggestion-modal__body">
        {error && <InlineNotification kind="error" title={error} lowContrast hideCloseButton />}
        <Select
          id="accept-parent"
          labelText="Parent tag (optional)"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <SelectItem value="" text="— No parent (top-level) —" />
          {parentOptions.map((p) => (
            <SelectItem key={p.id} value={p.id} text={p.name} />
          ))}
        </Select>
      </div>
    </Modal>
  );
};
