import React, { useEffect, useRef } from 'react';
import { AthenaMotion, athenaMarkState, athenaPosition, replyAnchorVisible, ATHENA_ANSWER_MS, type AthenaAnchors, type AthenaMotionPhase, type MotionPoint } from '../../chat/athenaMotion';
import { AthenaMark, type AthenaMarkElement } from './AthenaMark';
import { AthenaRibbon } from './AthenaRibbon';
import type { AthenaMood } from '../../chat/athenaMood';

interface AthenaPresenceProps {
  phase: AthenaMotionPhase;
  pending: boolean;
  answerAt: number | null;
  contextKey: string;
  host: React.RefObject<HTMLDivElement>;
  thread: React.RefObject<HTMLDivElement>;
  dock: React.RefObject<HTMLSpanElement>;
  thinker: React.RefObject<HTMLSpanElement>;
  reply: React.RefObject<HTMLSpanElement>;
  voiceLevel?: React.MutableRefObject<number>;
  mood?: AthenaMood;
}

export const AthenaGlyph: React.FC = () => <AthenaMark state="resting" />;

export const AthenaPresence: React.FC<AthenaPresenceProps> = ({ phase, pending, answerAt, contextKey, host, thread, dock, thinker, reply, voiceLevel, mood }) => {
  const sprite = useRef<HTMLDivElement>(null);
  const markElement = useRef<AthenaMarkElement>(null);
  const playback = useRef({ contextKey, motion: new AthenaMotion() });
  const previousAnchors = useRef<{ think: MotionPoint | null; mark: MotionPoint | null }>({ think: null, mark: null });

  useEffect(() => {
    const element = sprite.current, container = host.current, scroller = thread.current, home = dock.current;
    if (!element || !container || !scroller || !home) return;
    if (playback.current.contextKey !== contextKey) {
      playback.current = { contextKey, motion: new AthenaMotion() };
      previousAnchors.current = { think: null, mark: null };
    }
    const { motion } = playback.current;
    motion.setPhase(phase, Date.now(), answerAt);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let dirty = true;
    let onscreen = true;
    let visible = false;
    let anchors: AthenaAnchors;

    const measure = (): void => {
      const root = container.getBoundingClientRect(), dockRect = home.getBoundingClientRect();
      const viewport = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
      const threadRect = scroller.getBoundingClientRect();
      const point = (rect: DOMRect): { x: number; y: number } => ({
        x: (rect.left + rect.right) / 2 - root.left, y: (rect.top + rect.bottom) / 2 - root.top,
      });
      const dockPoint = point(dockRect);
      const markRect = reply.current?.getBoundingClientRect();
      const thinkRect = thinker.current?.getBoundingClientRect();
      const inView = (rect: DOMRect | undefined): rect is DOMRect =>
        rect !== undefined && replyAnchorVisible(rect, threadRect) && replyAnchorVisible(rect, viewport);
      const mark = inView(markRect) ? point(markRect)
        : markRect === undefined ? previousAnchors.current.mark ?? dockPoint : dockPoint;
      const answer = reply.current?.closest('.ai-bubble')?.getBoundingClientRect();
      const think = inView(thinkRect) ? point(thinkRect)
        : thinkRect !== undefined || phase === 'thinking' ? dockPoint
          : previousAnchors.current.think ?? (inView(markRect) && answer ? { x: (answer.left + answer.right) / 2 - root.left, y: mark.y + 35 } : dockPoint);
      // Keep the departure point when Stop or the next turn removes its DOM anchor.
      previousAnchors.current = { think, mark };
      anchors = { dock: dockPoint, row: dockPoint, think, mark };
      visible = onscreen && !document.hidden && root.width > 0 && root.height > 0
        && (replyAnchorVisible(dockRect, viewport) || inView(markRect) || inView(thinkRect));
      element.dataset.paused = String(!visible);
      element.style.visibility = visible ? 'visible' : 'hidden';
      markElement.current?.toggleAttribute('paused', !visible);
      dirty = false;
    };
    const paint = (): void => {
      frame = 0;
      if (dirty) measure();
      if (!visible) return;
      const now = Date.now();
      const { pose, active } = motion.sample(now, reducedMotion.matches);
      const position = athenaPosition(pose, anchors);
      element.style.transform = `translate(${position.x}px, ${position.y}px)`;
      element.dataset.phase = phase;
      if (markElement.current) {
        markElement.current.level = phase === 'listening' ? voiceLevel?.current ?? null : null;
        markElement.current.setAttribute('mood', mood ?? (phase === 'writing' && answerAt !== null && now - answerAt >= ATHENA_ANSWER_MS
          ? 'resting' : athenaMarkState(phase)));
      }
      if (active || phase === 'listening') frame = window.requestAnimationFrame(paint);
    };
    const update = (): void => {
      dirty = true;
      if (frame === 0) frame = window.requestAnimationFrame(paint);
    };
    const visibilityChanged = (): void => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      dirty = true;
      paint();
    };
    paint();
    const resize = new ResizeObserver(update);
    [container, scroller, home, thinker.current, reply.current, reply.current?.closest('.ai-bubble')]
      .forEach(node => { if (node) resize.observe(node); });
    const intersection = new IntersectionObserver(entries => {
      onscreen = entries[0]?.isIntersecting ?? false;
      visibilityChanged();
    });
    intersection.observe(container);
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    document.addEventListener('visibilitychange', visibilityChanged);
    reducedMotion.addEventListener('change', visibilityChanged);
    return () => {
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      document.removeEventListener('visibilitychange', visibilityChanged);
      reducedMotion.removeEventListener('change', visibilityChanged);
    };
  }, [phase, pending, answerAt, contextKey, host, thread, dock, thinker, reply, voiceLevel, mood]);

  return <><div ref={sprite} className="ai-presence" aria-hidden="true">
    <AthenaRibbon ribbonRef={markElement} mood={mood ?? athenaMarkState(phase)}
      size={phase === 'thinking' || phase === 'sending' ? 96 : phase === 'writing' ? 32 : 44} />
  </div><span className="ai-presence-announcement" role="status">{phase === 'writing' ? 'Athena replied' : ''}</span></>;
};
