/** Loads one decision's semantic state and wires the explicit-action controls to the API. */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import type { DecisionSemantics } from '../../types/semanticDecision';
import { DecisionSemanticsView } from './DecisionSemanticsView';

export const DecisionSemanticsPanel: React.FC<{ decisionId: string }> = ({ decisionId }) => {
  const queryClient = useQueryClient();
  const key = ['decision-semantics', decisionId];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: key, queryFn: () => api.getDecisionSemantics(decisionId) });

  const act = (action: () => Promise<DecisionSemantics>): void => {
    setBusy(true);
    setError(null);
    action()
      .then((next) => { queryClient.setQueryData(key, next); })
      .catch((err: unknown) => { setError(describeApiError(err)); })
      .finally(() => { setBusy(false); });
  };

  if (query.isLoading) return <InlineLoading description="Loading decision details…" />;
  if (query.data === undefined) return <p className="decision-semantics__error" role="alert">{query.error === null ? 'Couldn’t load the decision details.' : describeApiError(query.error)}</p>;
  return (
    <DecisionSemanticsView
      semantics={query.data}
      busy={busy}
      error={error}
      onConfirm={() => { act(() => api.confirmDecisionAcceptance(decisionId)); }}
      onSetReviewDate={(date) => { act(() => api.setDecisionReviewDate(decisionId, date)); }}
      onRecordLink={(link) => { act(() => api.recordDecisionLink(decisionId, link)); }}
    />
  );
};
