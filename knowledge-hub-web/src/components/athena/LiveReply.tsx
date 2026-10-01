/**
 * components/athena/LiveReply.tsx — Athena's reply while she's working: the
 * answer as it streams in, with a live line saying what she's doing and for
 * how long ("Searching your Library for “underwriting queue”… 12s").
 */
import React, { useEffect, useState } from 'react';
import { InlineLoading } from '@carbon/react';
import { renderAssistantMessage } from './renderReply';

interface LiveReplyProps {
  activity: string;
  text: string;
  startedAt: number;
  renderContext: Parameters<typeof renderAssistantMessage>[1];
}

export const LiveReply: React.FC<LiveReplyProps> = ({ activity, text, startedAt, renderContext }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const writing = text !== '';
  return (
    <div className={`ai-bubble ai-bubble--ai ai-bubble--live${writing ? '' : ' ai-bubble--thinking'}`} aria-live="polite">
      {writing && (
        <div
          className="ai-bubble-text ai-bubble-text--md"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderAssistantMessage(text, renderContext) }}
        />
      )}
      <InlineLoading
        className="ai-live-activity"
        description={`${writing ? 'Writing' : activity}… ${seconds.toString()}s`}
      />
    </div>
  );
};
