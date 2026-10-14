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
  initialTags?: string[];
}

export const SparkCaptureButton: React.FC<SparkCaptureButtonProps> = ({
  sourceId, initialTags = [],
}) => {
  const qc = useQueryClient();
  const saving = useRef(false);
  const mutation = useMutation({
    mutationFn: async () => requireApiData(await api.createArticleSpark(sourceId, initialTags)),
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
        title={mutation.isSuccess ? 'Spark saved from this article' : 'Read the article and create a spark from its argument'}
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
        {mutation.isPending ? 'Reading article...' : mutation.isSuccess ? 'Spark saved' : 'Spark'}
      </button>
      {mutation.isError && (
        <span className="dc-spark-error" role="alert">
          Could not save spark: {mutation.error.message} Click Spark to retry.
        </span>
      )}
    </>
  );
};
