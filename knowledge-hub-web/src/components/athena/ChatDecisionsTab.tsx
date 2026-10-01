/**
 * components/athena/ChatDecisionsTab.tsx — the Decisions tab of the chat side
 * panel: what's been decided and what's still open in this chat. Kept up to
 * date after each exchange (for the specialist personas, or when switched
 * on); everything here can be edited, and Athena works from this list.
 */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Checkmark, Close, Undo } from '@carbon/icons-react';
import { api } from '../../services/api';
import type { ChatDecision } from '../../types';

interface ChatDecisionsTabProps {
  sessionId: string | null;
  refreshKey: number;
}

export const ChatDecisionsTab: React.FC<ChatDecisionsTabProps> = ({ sessionId, refreshKey }) => {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [newText, setNewText] = useState('');
  const [newStatus, setNewStatus] = useState<ChatDecision['status']>('decided');

  const query = useQuery({
    queryKey: ['chat-decisions', sessionId, refreshKey],
    queryFn: async () => {
      if (sessionId === null) return null;
      const r = await api.getChatDecisions(sessionId);
      return r.success ? r.data : null;
    },
  });
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['chat-decisions', sessionId] }); };

  if (sessionId === null) {
    return <div className="ai-panel-empty">Start a chat and the points you agree — and the questions still open — are listed here.</div>;
  }
  if (query.isLoading || query.data === undefined) return <InlineLoading description="Loading decisions…" />;
  if (query.data === null) return <div className="ai-panel-empty">Couldn’t load the decisions for this chat.</div>;

  const { tracking, decisions } = query.data;
  const decided = decisions.filter((d) => d.status === 'decided');
  const open = decisions.filter((d) => d.status === 'open');

  const saveEdit = (d: ChatDecision): void => {
    const text = editText.trim();
    setEditingId(null);
    if (text === '' || text === d.text) return;
    void api.updateChatDecision(d.id, { text }).then(refresh);
  };

  const item = (d: ChatDecision): React.ReactNode => (
    <li key={d.id} className="ai-decision">
      {editingId === d.id ? (
        <input
          className="ai-decision__input"
          value={editText}
          autoFocus
          aria-label="Edit"
          onChange={(e) => { setEditText(e.target.value); }}
          onBlur={() => { saveEdit(d); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveEdit(d);
            if (e.key === 'Escape') setEditingId(null);
          }}
        />
      ) : (
        <button
          type="button"
          className="ai-decision__text"
          title="Click to edit"
          onClick={() => { setEditingId(d.id); setEditText(d.text); }}
        >
          {d.text}
          {d.source === 'user' && <span className="ai-decision__by"> · you</span>}
        </button>
      )}
      <span className="ai-decision__actions">
        <button
          type="button"
          className="ai-decision__btn"
          title={d.status === 'open' ? 'Mark decided' : 'Reopen'}
          onClick={() => { void api.updateChatDecision(d.id, { status: d.status === 'open' ? 'decided' : 'open' }).then(refresh); }}
        >
          {d.status === 'open' ? <Checkmark size={14} aria-hidden="true" /> : <Undo size={14} aria-hidden="true" />}
          <span className="cds--visually-hidden">{d.status === 'open' ? 'Mark decided' : 'Reopen'}</span>
        </button>
        <button
          type="button"
          className="ai-decision__btn"
          title="Remove"
          onClick={() => { void api.deleteChatDecision(d.id).then(refresh); }}
        >
          <Close size={14} aria-hidden="true" /><span className="cds--visually-hidden">Remove</span>
        </button>
      </span>
    </li>
  );

  return (
    <div className="ai-decisions">
      <label className="ai-decisions__tracking">
        <input
          type="checkbox"
          checked={tracking.enabled}
          onChange={(e) => {
            // Back to the persona default when that matches, so the chat follows persona changes.
            const value = e.target.checked === tracking.personaDefault ? null : e.target.checked;
            void api.setDecisionTracking(sessionId, value).then(refresh);
          }}
        />
        Keep this list up to date as we talk
        {tracking.explicit === null && <span className="ai-decisions__hint"> (on by default for Demo Designer, Brainstorm and Blog Post)</span>}
      </label>

      {decisions.length === 0 && (
        <p className="ai-panel-empty">
          {tracking.enabled
            ? 'Nothing decided yet. As you agree things in this chat they’re listed here, with questions still open. Athena works from this list.'
            : 'The list isn’t being kept for this chat. Switch it on above, or add points yourself.'}
        </p>
      )}

      {decided.length > 0 && (
        <section>
          <h4 className="ai-decisions__heading">Decided</h4>
          <ul className="ai-decisions__list">{decided.map(item)}</ul>
        </section>
      )}
      {open.length > 0 && (
        <section>
          <h4 className="ai-decisions__heading">Open</h4>
          <ul className="ai-decisions__list">{open.map(item)}</ul>
        </section>
      )}

      <form
        className="ai-decisions__add"
        onSubmit={(e) => {
          e.preventDefault();
          const text = newText.trim();
          if (text === '') return;
          void api.addChatDecision(sessionId, newStatus, text).then(() => { setNewText(''); refresh(); });
        }}
      >
        <select value={newStatus} onChange={(e) => { setNewStatus(e.target.value as ChatDecision['status']); }} aria-label="Type">
          <option value="decided">Decided</option>
          <option value="open">Open</option>
        </select>
        <input
          value={newText}
          onChange={(e) => { setNewText(e.target.value); }}
          placeholder="Add a point…"
          aria-label="Add a point"
        />
        <button type="submit" disabled={newText.trim() === ''}>Add</button>
      </form>
    </div>
  );
};
