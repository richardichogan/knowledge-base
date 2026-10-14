/**
 * PlanReviewModal — Athena's weekly review of the Plan.
 * Shows proposed changes (reschedule, complete, archive, split) with reasons; the user ticks the
 * ones to apply. Nothing changes until "Apply selected".
 */
import React, { useEffect, useState } from 'react';
import { InlineLoading, InlineNotification, Modal } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type PlanReviewAction, type PlanReviewProposal } from '../../services/api';
import { toISODateString } from '../../utils/dates';

const ACTION_LABEL: Record<PlanReviewAction, string> = {
  reschedule: 'Reschedule', complete: 'Mark done', archive: 'Archive', split: 'Split',
};

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

async function applyProposal(p: PlanReviewProposal): Promise<void> {
  if (p.action === 'reschedule' && p.dueDate) { await api.updateTask(p.taskId, { dueDate: p.dueDate }); return; }
  if (p.action === 'complete') { await api.updateTask(p.taskId, { status: 'completed' }); return; }
  if (p.action === 'archive') { await api.archiveTask(p.taskId); return; }
  if (p.action === 'split' && p.subtasks) {
    for (const title of p.subtasks) {
      await api.createTask({ title, status: 'backlog', projectId: p.projectId, priority: p.priority, body: `Split from "${p.title}" in the weekly review.` });
    }
    await api.archiveTask(p.taskId);
  }
}

export const PlanReviewModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyError, setApplyError] = useState<string | null>(null);

  const review = useMutation({
    mutationFn: async () => {
      const res = await api.reviewPlan(toISODateString(new Date()));
      if (!res.success) throw new Error(res.error.message);
      return res.data;
    },
    onSuccess: (data) => { setSelected(new Set(data.proposals.map((p) => p.taskId))); },
  });
  const { mutate: runReview, reset: resetReview } = review;

  useEffect(() => {
    if (!open) return;
    setApplyError(null);
    runReview();
    return () => { resetReview(); };
  }, [open, runReview, resetReview]);

  const apply = useMutation({
    mutationFn: async (proposals: PlanReviewProposal[]) => {
      const failed: string[] = [];
      for (const p of proposals) {
        try { await applyProposal(p); } catch (err) {
          console.error('[PlanReview] could not apply proposal', p, err);
          failed.push(p.title);
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      if (failed.length > 0) setApplyError(`Could not update: ${failed.join(', ')}. The rest were applied.`);
      else onClose();
    },
  });

  const proposals = review.data?.proposals ?? [];
  const chosen = proposals.filter((p) => selected.has(p.taskId));
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Modal
      open={open}
      modalHeading="Weekly review"
      modalLabel="Athena"
      primaryButtonText={apply.isPending ? 'Applying…' : chosen.length > 0 ? `Apply ${chosen.length} selected` : 'Apply selected'}
      secondaryButtonText="Close"
      primaryButtonDisabled={chosen.length === 0 || apply.isPending || review.isPending}
      onRequestClose={() => { if (!apply.isPending) onClose(); }}
      onRequestSubmit={() => { setApplyError(null); apply.mutate(chosen); }}
      size="md"
    >
      <div className="plan-review">
        {review.isPending && <InlineLoading description="Athena is reviewing your open tasks…" />}
        {review.isError && (
          <InlineNotification kind="error" title="Review failed" lowContrast hideCloseButton
            subtitle={review.error instanceof Error ? review.error.message : 'Please try again.'} />
        )}
        {applyError !== null && <InlineNotification kind="warning" title="Partly applied" subtitle={applyError} lowContrast hideCloseButton />}
        {review.data && (
          <p className="plan-review__intro">
            {proposals.length === 0
              ? `Reviewed ${review.data.reviewed} open tasks — nothing needs changing this week.`
              : `Reviewed ${review.data.reviewed} open tasks. Untick anything you don't want.`}
            {review.data.source === 'rules' && ' (Athena was unavailable, so these are simple rule-based suggestions.)'}
          </p>
        )}
        {proposals.length > 0 && (
          <ul className="plan-review__list">
            {proposals.map((p) => (
              <li key={p.taskId}>
                <label className={`plan-review__item${selected.has(p.taskId) ? ' plan-review__item--on' : ''}`}>
                  <input type="checkbox" className="plan-review__check" checked={selected.has(p.taskId)}
                    onChange={() => { toggle(p.taskId); }} disabled={apply.isPending} />
                  <span className="plan-review__body">
                    <span className="plan-review__head">
                      <span className={`plan-review__action plan-review__action--${p.action}`}>{ACTION_LABEL[p.action]}</span>
                      <span className="plan-review__title">{p.title}</span>
                    </span>
                    {p.action === 'reschedule' && p.dueDate && <span className="plan-review__detail">New due date: {formatDate(p.dueDate)}</span>}
                    {p.action === 'split' && p.subtasks && (
                      <span className="plan-review__detail">Into: {p.subtasks.join(' · ')}</span>
                    )}
                    {p.reason !== '' && <span className="plan-review__reason">{p.reason}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
};
