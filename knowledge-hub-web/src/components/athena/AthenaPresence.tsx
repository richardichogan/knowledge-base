import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { athenaMarkState, type AthenaMotionPhase } from '../../chat/athenaMotion';
import { AthenaMark } from './AthenaMark';
import { AthenaRibbon, type AthenaRibbonElement } from './AthenaRibbon';
import type { AthenaMood } from '../../chat/athenaMood';

interface AthenaPresenceProps {
  phase: AthenaMotionPhase;
  pending: boolean;
  responseKey: string;
  dock: React.RefObject<HTMLSpanElement>;
  thinker: React.RefObject<HTMLSpanElement>;
  voiceLevel?: React.MutableRefObject<number>;
  mood?: AthenaMood;
}

export const AthenaGlyph: React.FC = () => <AthenaMark state="resting" />;

export const AthenaPresence: React.FC<AthenaPresenceProps> = ({ phase, pending, responseKey, dock, thinker, voiceLevel, mood }) => {
  const ribbon = useRef<AthenaRibbonElement>(null);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);

  // Resolve after refs are attached: the home moves into the newest saved reply.
  useEffect(() => {
    const next = (pending || phase === 'thinking' ? thinker.current : null) ?? dock.current;
    setAnchor(next);
  }, [pending, phase, responseKey, thinker, dock]);

  useEffect(() => {
    const element = ribbon.current;
    if (!element || !anchor) return;
    let frame = 0;
    let onscreen = true;
    const paint = (): void => {
      element.level = phase === 'listening' ? voiceLevel?.current ?? null : null;
      if (phase === 'listening' && onscreen && !document.hidden) frame = requestAnimationFrame(paint);
    };
    const update = (): void => {
      cancelAnimationFrame(frame);
      element.toggleAttribute('paused', !onscreen || document.hidden);
      if (onscreen && !document.hidden) paint();
    };
    const observer = new IntersectionObserver(entries => {
      onscreen = entries[0]?.isIntersecting ?? false;
      update();
    });
    observer.observe(anchor);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      element.level = null;
    };
  }, [anchor, phase, voiceLevel]);

  return anchor === null ? null : createPortal(
    <span className="ai-presence-inline" aria-hidden="true">
      <AthenaRibbon ribbonRef={ribbon} mood={mood ?? athenaMarkState(phase)}
        interaction={phase === 'typing' ? 'typing' : phase === 'listening' ? 'voice' : phase === 'idle' ? 'idle' : undefined}
        size={56} />
    </span>,
    anchor,
  );
};
