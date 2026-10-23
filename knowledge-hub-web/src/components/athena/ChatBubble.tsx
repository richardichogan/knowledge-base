import React, { useMemo } from 'react';

interface ChatBubbleProps {
  role: 'user' | 'assistant';
  arrivalAt?: number | null;
  thinking?: boolean;
  live?: boolean;
  children: React.ReactNode;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({ role, arrivalAt, thinking = false, live = false, children }) => {
  // A live reply becoming a saved reply keeps the original choreography clock.
  const delay = useMemo(() => arrivalAt == null ? 0 : Math.min(0, arrivalAt - Date.now()), [arrivalAt]);
  const style: React.CSSProperties & { '--ai-arrival-delay': string } = { '--ai-arrival-delay': `${delay}ms` };
  return (
    <div
      className={`ai-bubble ai-bubble--${role === 'user' ? 'user' : 'ai'}${thinking ? ' ai-bubble--thinking' : ''}${live ? ' ai-bubble--live' : ''}${arrivalAt != null ? role === 'user' ? ' ai-question-arrival' : ' ai-answer-arrival' : ''}`}
      style={style}
      aria-label={role === 'user' ? 'You' : 'Athena'}
    >
      {role === 'assistant' && !thinking && <span className="ai-answer-panel" aria-hidden="true" />}
      {children}
    </div>
  );
};
