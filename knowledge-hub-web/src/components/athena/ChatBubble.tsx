import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface ChatBubbleProps {
  role: 'user' | 'assistant';
  arrivalAt?: number | null;
  thinking?: boolean;
  children: React.ReactNode;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({ role, arrivalAt, thinking = false, children }) => {
  // Unrelated renders must not restart a completed answer's entrance.
  const delay = useMemo(() => arrivalAt == null ? 0 : Math.min(0, arrivalAt - Date.now()), [arrivalAt]);
  const style: React.CSSProperties & { '--ai-arrival-delay': string } = { '--ai-arrival-delay': `${delay}ms` };
  const bubble = useRef<HTMLDivElement>(null);
  useBrowserLayoutEffect(() => {
    if (arrivalAt == null || role !== 'assistant' || thinking || !bubble.current) return;
    const update = (): void => {
      const rect = bubble.current!.getBoundingClientRect();
      bubble.current!.style.setProperty('--ai-answer-scale-x', String(Math.min(1, 72 / Math.max(1, rect.width))));
      bubble.current!.style.setProperty('--ai-answer-scale-y', String(Math.min(1, 72 / Math.max(1, rect.height))));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bubble.current);
    return () => { observer.disconnect(); };
  }, [arrivalAt, role, thinking]);
  return (
    <div
      ref={bubble}
      className={`ai-bubble ai-bubble--${role === 'user' ? 'user' : 'ai'}${thinking ? ' ai-bubble--thinking' : ''}${arrivalAt != null ? role === 'user' ? ' ai-question-arrival' : ' ai-answer-arrival' : ''}`}
      style={style}
      aria-label={role === 'user' ? 'You' : 'Athena'}
    >
      {role === 'assistant' && !thinking && <span className="ai-answer-panel" aria-hidden="true" />}
      {children}
    </div>
  );
};
