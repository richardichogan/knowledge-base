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
  thinkerRef: React.RefObject<HTMLSpanElement>;
}

export const ThinkingReply: React.FC<{
  activity: string;
  presenceRef: React.RefObject<HTMLSpanElement>;
  seconds?: number;
}> = ({ activity, presenceRef, seconds }) => (
  <ChatBubble role="assistant" thinking>
    <span ref={presenceRef} className="ai-presence-think-anchor" aria-hidden="true" />
    <div className="ai-live-activity">
      <span className="ai-live-activity__label" role="status">{activity}…</span>
      {seconds !== undefined && <span className="ai-live-activity__time" aria-hidden="true">{seconds.toString()}s</span>}
      {seconds !== undefined && seconds >= 8 && <span className="ai-live-activity__helper">Still working…</span>}
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
