/**
 * Thumbs up / down on a Discover article. Votes teach Athena which sources to rank
 * higher or lower; a thumbs down also archives the article. Clicking the active
 * vote clears it.
 */

import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ThumbsUp, ThumbsDown } from '@carbon/icons-react';
import { api, type DiscoverFeedbackVote } from '../../services/api';
import { requireApiData } from '../../services/apiError';

export interface DiscoverVoteProps {
  itemId: string;
  vote: DiscoverFeedbackVote;
  disabled?: boolean;
}

export const DiscoverVote: React.FC<DiscoverVoteProps> = ({ itemId, vote, disabled = false }) => {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<DiscoverFeedbackVote>(vote);
  const mutation = useMutation({
    mutationFn: async (next: DiscoverFeedbackVote) => requireApiData(await api.setDiscoverFeedback(itemId, next)),
    onMutate: (next) => { setCurrent(next); },
    onError: () => { setCurrent(vote); },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['discover'] });
      void queryClient.invalidateQueries({ queryKey: ['today-discover-ranked'] });
    },
  });
  const cast = (next: 'up' | 'down') => (e: React.MouseEvent): void => {
    e.stopPropagation();
    mutation.mutate(current === next ? null : next);
  };

  return (
    <span className="dc-vote" role="group" aria-label="Teach Athena">
      <button type="button" className={`dc-vote__btn${current === 'up' ? ' dc-vote__btn--up' : ''}`}
        aria-pressed={current === 'up'} title="More like this — ranks this source higher"
        aria-label="More like this — ranks this source higher"
        onClick={cast('up')} disabled={disabled || mutation.isPending}>
        <ThumbsUp size={14} />
      </button>
      <button type="button" className={`dc-vote__btn${current === 'down' ? ' dc-vote__btn--down' : ''}`}
        aria-pressed={current === 'down'} title="Less like this — gently lowers source ranking and dismisses For you or Shelved articles"
        aria-label="Less like this — gently lowers source ranking and dismisses For you or Shelved articles"
        onClick={cast('down')} disabled={disabled || mutation.isPending}>
        <ThumbsDown size={14} />
      </button>
      {mutation.isError && <span className="dc-vote__error" role="alert">
        Vote was not saved. {mutation.error instanceof Error ? mutation.error.message : 'Try again.'}
      </span>}
    </span>
  );
};
