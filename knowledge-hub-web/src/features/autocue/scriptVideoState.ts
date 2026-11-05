import { useSyncExternalStore } from 'react';
import type { PresentationVideoState } from '../../../../athena-desktop/src/elgatoProtocol';
import type { VisualVideoMode } from '../../../../knowledge-hub-backend/src/types/visualComposition';
import { desktopErrorMessage, getDesktop } from '../../types/desktop';

interface VideoSnapshot extends PresentationVideoState { loading: boolean }
let snapshot: VideoSnapshot = { mode: 'guide', status: 'idle', error: null, requestId: '',
  noteId: null, available: false, loading: false };
let revision = 0;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;

function publish(value: VideoSnapshot): void {
  snapshot = value;
  revision++;
  listeners.forEach(listener => listener());
  window.dispatchEvent(new Event('athena:script-visual-context'));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const desktop = getDesktop()?.presentation;
    if (desktop?.videoState && desktop.onVideoState) {
      publish({ ...snapshot, loading: true });
      unsubscribe = desktop.onVideoState(value => { publish({ ...value, loading: false }); });
      const requestedAt = revision;
      void desktop.videoState().then(value => {
        if (listeners.size && requestedAt === revision) publish({ ...value, loading: false });
      }).catch(error => {
        if (listeners.size && requestedAt === revision) publish({ ...snapshot, loading: false,
          error: `Could not read presenter video state: ${desktopErrorMessage(error)}` });
      });
    }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; revision++; }
  };
}

export function getScriptVideoState(): VideoSnapshot { return snapshot; }

export function useScriptVideoState(): VideoSnapshot {
  return useSyncExternalStore(subscribe, getScriptVideoState);
}

export async function setScriptVideoMode(noteId: string, mode: VisualVideoMode): Promise<void> {
  const desktop = getDesktop()?.presentation;
  if (!desktop) {
    if (mode === 'camera') throw new Error('Use an updated Athena Desktop to add your camera to the local audience output.');
    publish({ mode, status: 'idle', error: null, requestId: '', noteId: null, available: false, loading: false });
    return;
  }
  if (!desktop.scriptVisualVideo || !desktop.setVideoMode) throw new Error('Update Athena Desktop to control Guide, Camera and Off in the audience output.');
  const requestedAt = revision;
  const value = await desktop.setVideoMode(mode, noteId);
  if (requestedAt === revision) publish({ ...value, loading: false });
}

export function scriptVideoContext(): string {
  const { mode, status, error, noteId, available, loading } = snapshot;
  return `\n[Presenter video: ${JSON.stringify({ mode, status, error, noteId, available, loading })}. `
    + 'These are local output controls, not note content. Mode changes and camera permission are manual. '
    + 'Athena cannot activate the camera or inspect its frames. Only status "active" confirms a live browser camera; waiting/requesting does not. '
    + 'Guide/Off in a web-only preview does not confirm an audience output change.]';
}
