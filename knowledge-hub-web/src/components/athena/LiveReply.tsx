/**
 * components/athena/LiveReply.tsx — Athena's reply while she's working: the
 * status while a turn is running. Model deltas are not final answers: tools
 * and evidence repairs can discard them before the turn succeeds.
 */
import React, { useEffect, useState } from 'react';
import { ChatBubble } from './ChatBubble';

interface LiveReplyProps {
  activity: string;
  startedAt: number;
  thinkerRef: React.Ref<HTMLSpanElement>;
}

const progressLabel = (activity: string): string => {
  if (activity === 'Sending') return 'Receiving your message';
  if (activity === 'Loading context') return 'Gathering your conversation and context';
  if (activity === 'Loading tools') return 'Preparing the available tools';
  if (activity === 'Thinking') return 'Working through your request';
  if (activity === 'Reading what I found') return 'Reviewing the information found';
  return activity.replace(/[….\s]+$/, '');
};

export const ThinkingReply: React.FC<{
  activity: string;
  presenceRef: React.Ref<HTMLSpanElement>;
  seconds?: number;
}> = ({ activity, presenceRef, seconds }) => (
  <ChatBubble role="assistant" thinking>
    <div className="ai-progress">
      <div className="ai-progress__current">
        <span ref={presenceRef} className="ai-presence-anchor" aria-hidden="true" />
        <div className="ai-progress__text">
          <span key={activity} className="ai-progress__label" role="status">{progressLabel(activity)}…</span>
          {seconds !== undefined && <span className="ai-progress__time">{seconds.toString()}s elapsed</span>}
        </div>
      </div>
      {seconds !== undefined && seconds >= 15 && (
        <p className="ai-progress__helper">Still working on this step. You can stop at any time.</p>
      )}
    </div>
  </ChatBubble>
);

export const LiveReply: React.FC<LiveReplyProps> = ({ activity, startedAt, thinkerRef }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return <ThinkingReply activity={activity} presenceRef={thinkerRef} seconds={seconds} />;
};
