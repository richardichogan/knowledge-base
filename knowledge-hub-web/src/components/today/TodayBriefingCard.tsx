/**
 * components/today/TodayBriefingCard.tsx — Athena's morning briefing on the
 * Today page: overnight GitHub activity, what needs attention, today's
 * meetings and tasks. Made at 09:00 UK time; "Make it now" for earlier.
 */
import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineLoading } from '@carbon/react';
import { Renew, Chat } from '@carbon/icons-react';
import { api } from '../../services/api';
import { renderMarkdown } from '../../utils/markdown';
import { openBriefingInAthena } from '../../utils/morningBriefing';

export const TodayBriefingCard: React.FC = () => {
  const queryClient = useQueryClient();
  const [making, setMaking] = useState(false);
  const { data: briefing, isLoading } = useQuery({
    queryKey: ['morning-briefing'],
    queryFn: async () => { const r = await api.getMorningBriefing(); return r.success ? r.data : null; },
    staleTime: 5 * 60_000,
  });

  async function make(): Promise<void> {
    setMaking(true);
    try {
      const r = await api.generateMorningBriefing();
      if (r.success) queryClient.setQueryData(['morning-briefing'], r.data);
    } finally {
      setMaking(false);
    }
  }

  const made = briefing != null
    ? new Date(briefing.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="today-section-card today-briefing">
      <div className="today-section-card__header">
        <span className="today-section-card__title">Morning briefing</span>
        <div className="today-briefing__actions">
          {made !== null && <span className="today-briefing__time">Made at {made}</span>}
          {briefing != null && (
            <button type="button" className="kb-import-btn" onClick={() => { openBriefingInAthena(briefing.sessionId); }}>
              <Chat size={16} /> Discuss with Athena
            </button>
          )}
          <button type="button" className="kb-import-btn" disabled={making} onClick={() => { void make(); }}
            title={briefing != null ? 'Make it again with the latest activity' : 'Make today’s briefing now'}>
            <Renew size={16} /> {making ? 'Making…' : briefing != null ? 'Refresh' : 'Make it now'}
          </button>
        </div>
      </div>
      {isLoading && <InlineLoading description="Loading briefing…" />}
      {!isLoading && briefing == null && !making && (
        <p className="today-briefing__empty">Athena writes your briefing at 09:00 — overnight GitHub activity, what needs your attention, and today’s meetings and tasks.</p>
      )}
      {briefing != null && (
        <div
          className="today-briefing__body ai-bubble-text--md"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderMarkdown(briefing.markdown) }}
        />
      )}
    </div>
  );
};
