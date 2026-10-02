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
          dangerouslySetInnerHTML={{ __html: renderAssistantMessage(collapseLongBlocks(text), renderContext) }}
        />
      )}
      <InlineLoading
        className="ai-live-activity"
        description={`${writing ? 'Writing' : activity}… ${seconds.toString()}s`}
      />
    </div>
  );
};
