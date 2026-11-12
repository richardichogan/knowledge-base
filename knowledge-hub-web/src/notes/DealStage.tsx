import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from '@carbon/icons-react';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import { DEAL_STAGES, type DealStage } from './constants';

const DEAL_STAGES_KEY = ['deal-stages'] as const;

const isStage = (value: string | undefined): value is DealStage => DEAL_STAGES.some(stage => stage === value);

/** Stage per Deal desk note. Stage lives outside the note body, so the weekly job can move it without touching the text. */
export function useDealStages(enabled = true) {
  return useQuery({
    queryKey: DEAL_STAGES_KEY,
    queryFn: async () => requireApiData(await api.getDealStages()),
    enabled,
    staleTime: 30_000,
  });
}

export const DealStageBadge: React.FC<{ stage: string | undefined }> = ({ stage }) => {
  if (!isStage(stage)) return null;
  return <span className={`kh-deal-stage kh-deal-stage--${stage.toLowerCase()}`}>{stage}</span>;
};

/** Properties-panel selector for a Deal desk note's stage. */
export const DealStageProperties: React.FC<{ noteId: string; disabled: boolean }> = ({ noteId, disabled }) => {
  const queryClient = useQueryClient();
  const stages = useDealStages();
  const stage = stages.data?.[noteId];
  const change = useMutation({
    mutationFn: async (next: DealStage) => requireApiData(await api.setDealStage(noteId, next)),
    onSuccess: result => {
      queryClient.setQueryData<Record<string, string>>(DEAL_STAGES_KEY, previous => ({ ...previous, [result.noteId]: result.stage }));
    },
  });
  const value = change.variables && change.isPending ? change.variables : stage;
  const error = change.error ?? stages.error;
  return (
    <section className="kh-deal-properties" aria-label="Deal stage">
      <h3>Deal stage <DealStageBadge stage={value} /></h3>
      <label className="kh-deal-properties__field">
        <span className="notes-meta-section-label">Stage</span>
        <span className="notes-meta-select-field">
          <select
            className="notes-meta-type-select"
            value={isStage(value) ? value : ''}
            disabled={disabled || stages.isLoading || change.isPending}
            onChange={event => { change.mutate(event.target.value as DealStage); }}
          >
            {!isStage(value) && <option value="" disabled>{stages.isLoading ? 'Loading…' : 'Not set'}</option>}
            {DEAL_STAGES.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </span>
      </label>
      {error && <p className="kh-deal-properties__error" role="alert">{describeApiError(error)}</p>}
      {change.isPending && <p role="status">Saving…</p>}
      <p>The weekly job adds next steps and people and moves the stage. It never changes your headings or rows you have edited.</p>
    </section>
  );
};
