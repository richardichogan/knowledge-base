/**
 * components/sparks/SparkCaptureButton.tsx
 * Saves a Discover article's synopsis as a linked spark in one click.
 */
import React, { useRef } from 'react';
import { Checkmark, Flash } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { requireApiData } from '../../services/apiError';

interface SparkCaptureButtonProps {
  sourceId: string;
  sourceType: string;
  title: string;
  synopsis: string | null;
  initialTags?: string[];
}

export const SparkCaptureButton: React.FC<SparkCaptureButtonProps> = ({
  sourceId, sourceType, title, synopsis, initialTags = [],
}) => {
  const qc = useQueryClient();
  const saving = useRef(false);
  const mutation = useMutation({
    mutationFn: async () => requireApiData(await api.createSpark({
      body: [title.trim(), synopsis?.trim()].filter(Boolean).join('\n\n'),
      tags: initialTags,
      source_id: sourceId,
      source_type: sourceType,
    })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sparks'] });
      void qc.invalidateQueries({ queryKey: ['spark-clusters'] });
      void qc.invalidateQueries({ queryKey: ['today-sparks-recent'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onSettled: () => { saving.current = false; },
  });

  return (
    <>
      <button
        type="button"
        className={`dc-action dc-action--spark${mutation.isSuccess ? ' dc-action--spark-active' : ''}`}
        title={mutation.isSuccess ? 'Spark saved from this article' : 'Create a spark from the article synopsis'}
        disabled={mutation.isPending || mutation.isSuccess}
        aria-busy={mutation.isPending}
        onClick={(event) => {
          event.stopPropagation();
          if (saving.current || mutation.isSuccess) return;
          saving.current = true;
          mutation.mutate();
        }}
      >
        {mutation.isSuccess ? <Checkmark size={14} /> : <Flash size={14} />}
        {mutation.isPending ? 'Saving...' : mutation.isSuccess ? 'Spark saved' : 'Spark'}
      </button>
      {mutation.isError && (
        <span className="dc-spark-error" role="alert">
          Could not save spark: {mutation.error.message} Click Spark to retry.
        </span>
      )}
    </>
  );
};
