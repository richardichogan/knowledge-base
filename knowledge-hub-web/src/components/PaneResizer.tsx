/**
 * components/PaneResizer.tsx — draggable divider between two workspace panes.
 *
 * Renders a 1px rule with a wider invisible hit area, so the divider stays
 * visually hairline while remaining comfortably grabbable. Also operable from
 * the keyboard, since a pointer-only resize would put the layout out of reach
 * for keyboard and switch users.
 */

import React, { useCallback, useEffect, useRef } from 'react';

interface PaneResizerProps {
  /** Current width of the controlled pane, in px. */
  width: number;
  onResize: (next: number) => void;
  /**
   * Which side of the divider the controlled pane sits on. For a right-hand
   * pane, dragging left must *increase* its width, so the delta is inverted.
   */
  side: 'left' | 'right';
  label: string;
  /** px moved per arrow-key press. */
  step?: number;
}

export const PaneResizer: React.FC<PaneResizerProps> = ({
  width,
  onResize,
  side,
  label,
  step = 16,
}) => {
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragState.current = { startX: event.clientX, startWidth: width };
      // Capture on the *document* rather than the handle: a fast drag can
      // outrun the element under the cursor, and without capture the pane
      // would stick mid-drag as soon as the pointer left the 6px strip.
      document.body.classList.add('kh-pane-resizing');
    },
    [width],
  );

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const state = dragState.current;
      if (state === null) return;
      const delta = event.clientX - state.startX;
      onResize(state.startWidth + (side === 'right' ? -delta : delta));
    };
    const handleUp = () => {
      if (dragState.current === null) return;
      dragState.current = null;
      document.body.classList.remove('kh-pane-resizing');
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      document.body.classList.remove('kh-pane-resizing');
    };
  }, [onResize, side]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const grow = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
      const shrink = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
      if (event.key === grow) {
        event.preventDefault();
        onResize(width + step);
      } else if (event.key === shrink) {
        event.preventDefault();
        onResize(width - step);
      }
    },
    [onResize, side, step, width],
  );

  return (
    <div
      className="kh-pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      <span className="kh-pane-resizer__rule" aria-hidden="true" />
    </div>
  );
};
