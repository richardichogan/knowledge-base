/**
 * components/athena/LiveReply.tsx — Athena's reply while she's working: the
 * answer as it streams in, with a live line saying what she's doing and for
 * how long ("Searching your Library for “underwriting queue”… 12s").
 */
import React, { useEffect, useState } from 'react';
import { renderAssistantMessage } from './renderReply';
import { ChatBubble } from './ChatBubble';

interface LiveReplyProps {
  activity: string;
  text: string;
  startedAt: number;
  renderContext: Parameters<typeof renderAssistantMessage>[1];
  presenceRef: React.RefObject<HTMLSpanElement>;
  thinkerRef: React.RefObject<HTMLSpanElement>;
  arrivalAt: number | null;
}

const LONG_BLOCK_CHARS = 400;

/**
 * While she's still writing, a long copy-paste block (a GHCP prompt, say)
 * shows as a one-line placeholder instead of pouring into the reply — where
 * the Outputs panel is shown it is moved there when she finishes, and
 * elsewhere it appears in full in the finished reply.
 */
function collapseLongBlocks(text: string): string {
  return text.replace(/```[\w-]*\n([\s\S]*?)(\n```|$)/g, (block, inner: string) => {
    if (inner.length < LONG_BLOCK_CHARS) return block;
    const lines = inner.split('\n').length;
    return `> Writing a copy-paste block… (${lines.toString()} lines so far)`;
  });
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
    </div>
  </ChatBubble>
);

export const LiveReply: React.FC<LiveReplyProps> = ({ activity, text, startedAt, renderContext, presenceRef, thinkerRef, arrivalAt }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const writing = text !== '';
  if (!writing) return <ThinkingReply activity={activity} presenceRef={thinkerRef} seconds={seconds} />;
  return (
    <ChatBubble role="assistant" live arrivalAt={arrivalAt}>
      <div className="ai-reply-heading" aria-hidden="true">
        <span ref={presenceRef} className="ai-reply-heading__mark" />
        <span>Athena</span>
      </div>
      <span className="ai-live-writing" role="status">Writing…</span>
      <div
        className="ai-bubble-text ai-bubble-text--md"
        aria-live="polite"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: renderAssistantMessage(collapseLongBlocks(text), renderContext) }}
      />
    </ChatBubble>
  );
};
