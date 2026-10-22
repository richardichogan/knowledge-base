/** Loads one decision's semantic state and wires the explicit-action controls to the API. */
import React, { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { api } from '../../services/api';
import { describeApiError } from '../../services/apiError';
import type { DecisionLinkCandidate, DecisionSemantics } from '../../types/semanticDecision';
import { DecisionSemanticsView } from './DecisionSemanticsView';

export const DecisionSemanticsPanel: React.FC<{ decisionId: string }> = ({ decisionId }) => {
  const queryClient = useQueryClient();
  const key = ['decision-semantics', decisionId];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DecisionLinkCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const latestSearch = useRef(0);
  const query = useQuery({ queryKey: key, queryFn: () => api.getDecisionSemantics(decisionId) });

  const searchCandidates = useCallback((kind: 'task' | 'decision', q: string): void => {
    const ticket = ++latestSearch.current;
    setCandidatesLoading(true);
    api.getDecisionLinkCandidates(decisionId, kind, q)
      .then((items) => { if (ticket === latestSearch.current) setCandidates(items); })
      .catch((err: unknown) => { if (ticket === latestSearch.current) { setCandidates([]); setError(describeApiError(err)); } })
      .finally(() => { if (ticket === latestSearch.current) setCandidatesLoading(false); });
  }, [decisionId]);

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
      candidates={candidates}
      candidatesLoading={candidatesLoading}
      onSearchCandidates={searchCandidates}
      onConfirm={() => { act(() => api.confirmDecisionAcceptance(decisionId)); }}
      onSetReviewDate={(date) => { act(() => api.setDecisionReviewDate(decisionId, date)); }}
      onRecordLink={(link) => { act(() => api.recordDecisionLink(decisionId, link)); }}
    />
  );
};
