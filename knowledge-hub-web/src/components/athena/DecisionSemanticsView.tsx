/**
 * components/athena/DecisionSemanticsView.tsx — the explicit-user controls for one decision: confirm it was
 * accepted, set a review date, and record which task implements it or which decision it supersedes.
 * Nothing here is inferred; every change is a deliberate user action.
 */
import React, { useState } from 'react';
import type { DecisionLinkInput, DecisionLinkRelationship, DecisionSemantics, SemanticEdgeView } from '../../types/semanticDecision';

export interface DecisionSemanticsViewProps {
  semantics: DecisionSemantics;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onSetReviewDate: (reviewDate: string | null) => void;
  onRecordLink: (link: DecisionLinkInput) => void;
}

const ORIGIN_LABEL: Record<SemanticEdgeView['origin'], string> = { explicit: 'recorded', user_confirmed: 'you confirmed', inferred: 'suggested, not confirmed' };
const LINK_OPTIONS: ReadonlyArray<{ value: DecisionLinkRelationship; label: string; placeholder: string }> = [
  { value: 'implements', label: 'Is implemented by task', placeholder: 'Task id' },
  { value: 'supersedes', label: 'Supersedes decision', placeholder: 'Older decision id' },
  { value: 'superseded_by', label: 'Is superseded by decision', placeholder: 'Newer decision id' },
];

function describeEdge(edge: SemanticEdgeView, id: string): string {
  const other = edge.from.id === id ? edge.to : edge.from;
  const verb = edge.relationship === 'implements' ? 'Implemented by'
    : edge.relationship === 'supersedes' ? (edge.from.id === id ? 'Supersedes' : 'Superseded by')
      : edge.relationship;
  const when = edge.effectiveAt === null ? '' : ` from ${edge.effectiveAt.slice(0, 10)}`;
  return `${verb} ${other.kind} ${other.id}${when} (${ORIGIN_LABEL[edge.origin]})`;
}

export const DecisionSemanticsView: React.FC<DecisionSemanticsViewProps> = ({ semantics, busy = false, error = null, onConfirm, onSetReviewDate, onRecordLink }) => {
  const [confirmed, setConfirmed] = useState(false);
  const [reviewDate, setReviewDate] = useState(semantics.reviewDate ?? '');
  const [relationship, setRelationship] = useState<DecisionLinkRelationship>('implements');
  const [counterpartId, setCounterpartId] = useState('');
  const [effectiveAt, setEffectiveAt] = useState('');
  const option = LINK_OPTIONS.find((o) => o.value === relationship) ?? LINK_OPTIONS[0];
  const supersession = relationship !== 'implements';
  const links = semantics.edges.filter((e) => e.relationship === 'implements' || e.relationship === 'supersedes');

  return (
    <div className="decision-semantics">
      {error !== null && <p className="decision-semantics__error" role="alert">{error}</p>}

      <section className="decision-semantics__section">
        <h5 className="decision-semantics__heading">Acceptance</h5>
        {semantics.acceptance === 'accepted' ? (
          <p className="decision-semantics__text">Accepted — you confirmed this{semantics.acceptedAt === null ? '' : ` on ${semantics.acceptedAt.slice(0, 10)}`}.</p>
        ) : (
          <>
            <p className="decision-semantics__text">Acceptance is not recorded. It stays unknown until you confirm it.</p>
            <label className="decision-semantics__check">
              <input type="checkbox" checked={confirmed} onChange={(e) => { setConfirmed(e.target.checked); }} />
              I confirm this decision was accepted
            </label>
            <button type="button" className="decision-semantics__btn" disabled={!confirmed || busy} onClick={onConfirm}>Confirm acceptance</button>
          </>
        )}
      </section>

      <section className="decision-semantics__section">
        <h5 className="decision-semantics__heading">Review date</h5>
        <div className="decision-semantics__row">
          <input type="date" className="decision-semantics__input" aria-label="Review date" value={reviewDate} onChange={(e) => { setReviewDate(e.target.value); }} />
          <button type="button" className="decision-semantics__btn" disabled={busy || reviewDate === (semantics.reviewDate ?? '')} onClick={() => { onSetReviewDate(reviewDate === '' ? null : reviewDate); }}>
            {reviewDate === '' ? 'Clear review date' : 'Save review date'}
          </button>
        </div>
      </section>

      <section className="decision-semantics__section">
        <h5 className="decision-semantics__heading">Links</h5>
        {semantics.supersession.state === 'superseded' && <p className="decision-semantics__text">This decision has been superseded.</p>}
        {links.length === 0 ? <p className="decision-semantics__text">No tasks or superseding decisions are linked.</p> : (
          <ul className="decision-semantics__list">
            {links.map((e) => <li key={`${e.relationship}:${e.from.id}:${e.to.id}`} className={`decision-semantics__item decision-semantics__item--${e.origin}`}>{describeEdge(e, semantics.id)}</li>)}
          </ul>
        )}
        <div className="decision-semantics__row">
          <select className="decision-semantics__input" aria-label="Link type" value={relationship} onChange={(e) => { setRelationship(e.target.value as DecisionLinkRelationship); }}>
            {LINK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input className="decision-semantics__input" aria-label="Linked id" placeholder={option?.placeholder} value={counterpartId} onChange={(e) => { setCounterpartId(e.target.value); }} />
          {supersession && <input type="date" className="decision-semantics__input" aria-label="Effective date" value={effectiveAt} onChange={(e) => { setEffectiveAt(e.target.value); }} />}
          <button
            type="button"
            className="decision-semantics__btn"
            disabled={busy || counterpartId.trim() === ''}
            onClick={() => {
              onRecordLink({ relationship, counterpartId: counterpartId.trim(), ...(supersession && effectiveAt !== '' ? { effectiveAt } : {}) });
              setCounterpartId('');
            }}
          >
            Record link
          </button>
        </div>
      </section>
    </div>
  );
};
