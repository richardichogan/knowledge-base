/**
 * components/tags/PendingSuggestionRow.tsx
 * One row in the AI suggestion review queue.
 * Shows name, count, up to 3 example titles, and Accept/Reject/Merge actions.
 */
import React, { useState } from 'react';
import type { PendingSuggestion } from '../../services/api';
import { AcceptSuggestionModal } from './AcceptSuggestionModal';
import { MergeSuggestionModal } from './MergeSuggestionModal';
import { api } from '../../services/api';

interface Props {
  suggestion: PendingSuggestion;
  onRefresh: () => void;
}

export const PendingSuggestionRow: React.FC<Props> = ({ suggestion, onRefresh }) => {
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [mergeOpen,  setMergeOpen]  = useState(false);
  const [busy, setBusy]             = useState(false);

  const reject = async (): Promise<void> => {
    setBusy(true);
    try { await api.rejectTagSuggestion(suggestion.id); onRefresh(); }
    catch { /* silently fail — user can retry */ }
    finally { setBusy(false); }
  };

  const examples = suggestion.exampleContent.slice(0, 3);

  return (
    <div className="tag-suggestion-row">
      <div className="tag-suggestion-row__header">
        <span className="tag-suggestion-row__name">{suggestion.suggestedName}</span>
        <span className="tag-suggestion-row__count">{suggestion.suggestedCount}×</span>
      </div>

      {examples.length > 0 && (
        <ul className="tag-suggestion-row__examples">
          {examples.map((ex) => (
            <li key={ex} className="tag-suggestion-row__example">{ex}</li>
          ))}
        </ul>
      )}

      <div className="tag-suggestion-row__actions">
        <button type="button" className="tag-suggestion-row__btn tag-suggestion-row__btn--accept"
          onClick={() => setAcceptOpen(true)} disabled={busy}>
          Accept
        </button>
        <button type="button" className="tag-suggestion-row__btn tag-suggestion-row__btn--merge"
          onClick={() => setMergeOpen(true)} disabled={busy}>
          Merge
        </button>
        <button type="button" className="tag-suggestion-row__btn tag-suggestion-row__btn--reject"
          onClick={() => { void reject(); }} disabled={busy}>
          Reject
        </button>
      </div>

      <AcceptSuggestionModal
        open={acceptOpen}
        suggestionId={suggestion.id}
        suggestionName={suggestion.suggestedName}
        onClose={() => setAcceptOpen(false)}
        onDone={() => { setAcceptOpen(false); onRefresh(); }}
      />
      <MergeSuggestionModal
        open={mergeOpen}
        suggestionId={suggestion.id}
        suggestionName={suggestion.suggestedName}
        onClose={() => setMergeOpen(false)}
        onDone={() => { setMergeOpen(false); onRefresh(); }}
      />
    </div>
  );
};
