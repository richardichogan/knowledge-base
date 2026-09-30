/**
 * features/canvas/activeCanvas.ts — the canvas open in Think, so Athena's
 * proposed changes can be applied through the editor (instant, undoable)
 * instead of behind its back.
 */
import type { MapOp } from '../../services/api';

interface ActiveCanvas {
  canvasId: string;
  commit: (ops: MapOp[]) => void;
}

let active: ActiveCanvas | null = null;

export function setActiveCanvas(canvas: ActiveCanvas | null): void {
  active = canvas;
}

export function getActiveCanvas(canvasId: string): ActiveCanvas | null {
  return active !== null && active.canvasId === canvasId ? active : null;
}
