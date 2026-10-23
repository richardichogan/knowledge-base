import React, { useEffect, useRef, useState } from 'react';

export const SUGGESTION_ROTATION_MS = 7000;

export function composerSuggestions(steps: readonly string[] | undefined, contextType: string | undefined,
  fallback: readonly string[]): string[] {
  const supplied = [...new Set(steps?.map(step => step.trim()).filter(Boolean))];
  if (supplied.length) return supplied;
  if (contextType === 'note' || contextType === 'document') {
    const subject = contextType === 'note' ? 'note' : 'document';
    return [
      `Summarise this ${subject}`,
      `Extract the decisions and actions from this ${subject}`,
      `What needs clarification in this ${subject}?`,
    ];
  }
  return [...fallback];
}

export function ComposerSuggestion({ steps, onChoose }: {
  steps: string[];
  onChoose: (step: string) => void;
}): React.ReactElement | null {
  const suggestions = steps.filter(step => step.trim() !== '');
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const count = suggestions.length;
  const step = count > 0 ? suggestions[index % count] : undefined;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionChanged = (): void => { setReducedMotion(media.matches); };
    let onscreen = true;
    const visibilityChanged = (): void => { setVisible(onscreen && !document.hidden); };
    const observer = new IntersectionObserver(([entry]) => {
      onscreen = entry?.isIntersecting ?? false;
      visibilityChanged();
    });
    if (root.current) observer.observe(root.current);
    motionChanged();
    visibilityChanged();
    media.addEventListener('change', motionChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', motionChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [count]);

  useEffect(() => {
    if (count < 2 || hovered || focused || !visible || reducedMotion) return;
    const timer = window.setInterval(() => { setIndex(current => (current + 1) % count); }, SUGGESTION_ROTATION_MS);
    return () => { window.clearInterval(timer); };
  }, [count, index, hovered, focused, visible, reducedMotion]);

  if (step === undefined) return null;
  return <div ref={root} className="ai-composer-suggestion" role="group" aria-label="Suggested next steps"
    onMouseEnter={() => { setHovered(true); }} onMouseLeave={() => { setHovered(false); }}
    onFocusCapture={() => { setFocused(true); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <button type="button" className="ai-composer-suggestion__choose" aria-label={`Use suggestion: ${step}`}
      title={`Add to your message without sending: ${step}`} onClick={() => { onChoose(step); }}>
      <span key={index} className="ai-composer-suggestion__text">{step}</span>
    </button>
  </div>;
}
