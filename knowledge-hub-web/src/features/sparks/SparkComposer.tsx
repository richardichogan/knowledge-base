/**
 * features/sparks/SparkComposer.tsx
 * Inline spark creation form — persistent at the top of the Sparks panel.
 */
import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

interface SparkComposerProps {
  /** If the composer is embedded on a source item, pass its id and type. */
  sourceId?: string;
  sourceType?: string;
}

/**
 * Renders a text area and save button for capturing a new spark.
 * On save, invalidates the sparks list query so the panel refreshes.
 */
export const SparkComposer: React.FC<SparkComposerProps> = ({ sourceId, sourceType }) => {
  const [body, setBody] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => api.createSpark({
      body,
      tags: [],
      source_id: sourceId ?? null,
      source_type: sourceType ?? null,
    }),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ['sparks'] });
      void queryClient.invalidateQueries({ queryKey: ['unsurfaced-count'] });
    },
  });

  const canSave = body.trim().length > 0 && !mutation.isPending;

  function handleKeyDown(e: React.KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
      mutation.mutate();
    }
  }

  return (
    <div className="spark-composer">
      <textarea
        className="spark-composer__input"
        placeholder="Capture a thought…"
        value={body}
        onChange={(e) => { setBody(e.target.value); }}
        onKeyDown={handleKeyDown}
        rows={3}
      />
      <div className="spark-composer__footer">
        <span className="spark-composer__hint">Cmd+Enter to save</span>
        <button
          className="spark-composer__save"
          disabled={!canSave}
          onClick={() => { mutation.mutate(); }}
        >
          {mutation.isPending ? 'Saving…' : 'Save spark'}
        </button>
      </div>
    </div>
  );
};
