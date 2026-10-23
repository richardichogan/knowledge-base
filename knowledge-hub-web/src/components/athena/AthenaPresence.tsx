import React, { useEffect, useRef } from 'react';
import { AthenaMotion, athenaGlyphFrame, athenaPosition, replyAnchorVisible, type AthenaAnchors, type AthenaMotionPhase, type MotionPoint } from '../../chat/athenaMotion';

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
}

export const AthenaGlyph: React.FC = () => (
  <span className="ai-presence-glyph" aria-hidden="true">
    <span className="ai-presence-glyph__piece" />
    <span className="ai-presence-glyph__piece" />
    <span className="ai-presence-glyph__piece" />
    <span className="ai-presence-glyph__piece" />
  </span>
);

export const AthenaPresence: React.FC<AthenaPresenceProps> = ({ phase, pending, answerAt, contextKey, host, thread, dock, thinker, reply }) => {
  const sprite = useRef<HTMLDivElement>(null);
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
    const pieces = [...element.querySelectorAll<HTMLElement>('.ai-presence-glyph__piece')];
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
      anchors = { dock: dockPoint, row: { x: Math.min(dockPoint.x + 45, root.width - 24), y: dockPoint.y }, think, mark };
      visible = onscreen && !document.hidden && root.width > 0 && root.height > 0
        && (replyAnchorVisible(dockRect, viewport) || inView(markRect) || inView(thinkRect));
      element.dataset.paused = String(!visible);
      element.style.visibility = visible ? 'visible' : 'hidden';
      dirty = false;
    };
    const paint = (): void => {
      frame = 0;
      if (dirty) measure();
      if (!visible) return;
      const now = Date.now();
      const { pose, active, voice } = motion.sample(now, reducedMotion.matches);
      const position = athenaPosition(pose, anchors);
      element.style.transform = `translate(${position.x}px, ${position.y}px)`;
      element.dataset.idle = String(!active && pose.row === 0 && pose.think === 0 && pose.mark === 0);
      element.dataset.phase = phase;
      const shapes = athenaGlyphFrame(pose, reducedMotion.matches ? 0 : now / 1000, voice);
      shapes.forEach((shape, i) => {
        const piece = pieces[i]!;
        piece.style.width = `${shape.size + 0.25}px`;
        piece.style.height = `${shape.size + 0.25}px`;
        piece.style.borderRadius = shape.radius.map(r => `${r}px`).join(' ');
        piece.style.transform = `translate(${shape.x - shape.size / 2}px, ${shape.y - shape.size / 2}px) rotate(${shape.rotation}deg) scale(${shape.scale})`;
        piece.style.backgroundColor = `color-mix(in srgb, var(--ai-motion-color-0), var(--ai-motion-color-${shape.colorIndex}) ${shape.colorMix * 100}%)`;
      });
      if (active) frame = window.requestAnimationFrame(paint);
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
  }, [phase, pending, answerAt, contextKey, host, thread, dock, thinker, reply]);

  return <div ref={sprite} className="ai-presence" aria-hidden="true"><AthenaGlyph /></div>;
};
