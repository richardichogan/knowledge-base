import type { PresentationVisualScene } from '../../../../athena-desktop/src/elgatoProtocol';
import { requiresVisualAssets, requiresVisualCraft, requiresVisualMotion } from './presentationScript';

let presented: { noteId: string; issue: string | null } | null = null;

export function visualBrandingIssue(scenes: ReadonlyArray<{ brandMark?: 'ibm-8bar' }> | undefined, supported?: boolean): string | null {
  return scenes?.some(scene => scene.brandMark) && !supported
    ? 'Update Athena Desktop to present the closing IBM logo. Web preview remains available.' : null;
}

export function visualAssetsIssue(scenes: PresentationVisualScene[] | undefined, supported?: boolean): string | null {
  return scenes && requiresVisualAssets(scenes) && !supported
    ? 'Update Athena Desktop to present the drawn graphics and build states. Web preview remains available.' : null;
}

/** Presenting text never depends on this: an older Desktop plain-presents and the issue only surfaces when browser visuals are opened. */
export function desktopVisualIssue(scenes: PresentationVisualScene[] | undefined,
  desktop: {
    scriptVisuals?: boolean; scriptVisualCompositions?: boolean; scriptVisualMotion?: boolean; scriptVisualCraft?: boolean;
    scriptVisualBranding?: boolean; scriptVisualAssets?: boolean;
  } | undefined): string | null {
  if (!scenes?.length) return null;
  return visualBrandingIssue(scenes, desktop?.scriptVisualBranding)
    ?? visualAssetsIssue(scenes, desktop?.scriptVisualAssets)
    ?? (!desktop?.scriptVisuals ? 'Update Athena Desktop to present synchronised browser visuals. Web preview remains available.' : null)
    ?? (scenes.some(scene => scene.composition) && !desktop?.scriptVisualCompositions
      ? 'Update Athena Desktop to present layered visuals. Web preview remains available.' : null)
    ?? (requiresVisualMotion(scenes) && !desktop?.scriptVisualMotion
      ? 'Update Athena Desktop to present the new visual animations and presenter layout. Web preview remains available.' : null)
    ?? (requiresVisualCraft(scenes) && !desktop?.scriptVisualCraft
      ? 'Update Athena Desktop to present the corrected connectors, image headers and video guide. Web preview remains available.' : null);
}

export function recordPresentedVisuals(noteId: string, issue: string | null): void {
  presented = { noteId, issue };
}
export function presentedVisualIssue(noteId: string): string | null {
  return presented?.noteId === noteId ? presented.issue : null;
}

export async function openPresentationVisuals(start: () => Promise<void>, issue: () => string | null,
  open: () => Promise<void>): Promise<void> {
  await start();
  const error = issue();
  if (error) throw new Error(error);
  await open();
}
