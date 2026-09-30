/**
 * features/canvas/activeMindMap.ts — the mind map open in Think, so Athena's
 * proposed map changes can be applied through the editor (instant, undoable)
 * instead of behind its back.
 */
import type { MapOp } from '../../services/api';

interface ActiveMap {
  canvasId: string;
  commit: (ops: MapOp[]) => void;
}

let active: ActiveMap | null = null;

export function setActiveMindMap(map: ActiveMap | null): void {
  active = map;
}

export function getActiveMindMap(canvasId: string): ActiveMap | null {
  return active !== null && active.canvasId === canvasId ? active : null;
}
