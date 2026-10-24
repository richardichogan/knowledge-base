import React, { useLayoutEffect, useRef } from 'react';

export function AnswerText({ html, arrivalAt, onComplete }: {
  html: string;
  arrivalAt: number | null;
  onComplete: () => void;
}): React.ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const complete = useRef(onComplete);
  complete.current = onComplete;

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || arrivalAt === null) return;
    const blocks = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || blocks.length === 0) {
      complete.current();
      return;
    }
    const interval = Math.min(220, 2400 / blocks.length);
    const timers: number[] = [];
    blocks.forEach((block, index) => {
      block.hidden = index > 0;
      if (index === 0) block.classList.add('ai-answer-text__enter');
      else timers.push(window.setTimeout(() => {
        block.hidden = false;
        block.classList.add('ai-answer-text__enter');
      }, index * interval));
    });
    timers.push(window.setTimeout(() => { complete.current(); }, (blocks.length - 1) * interval + 420));
    return () => {
      timers.forEach(window.clearTimeout);
      blocks.forEach(block => { block.hidden = false; block.classList.remove('ai-answer-text__enter'); });
    };
  }, [html, arrivalAt]);

  return <div ref={root} className="ai-bubble-text ai-bubble-text--md ai-answer-text"
    dangerouslySetInnerHTML={{ __html: html }} />;
}
