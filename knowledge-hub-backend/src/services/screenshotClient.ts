/**
 * services/screenshotClient.ts — asks the internal screenshot service
 * (screenshot-service/, deployed as kh-prod-shot) to render a public web page
 * or an HTML mock-up at device sizes, for Athena to look at.
 */
import { env } from '../config/env.js';

export type ShotDevice = 'desktop' | 'tablet' | 'mobile';

export interface ShotImage {
  device: ShotDevice;
  width: number;
  height: number;
  mimeType: string;
  base64: string;
}

/** The service scales to zero, so the first capture after a quiet spell includes its start-up. */
const SHOT_TIMEOUT_MS = 110_000;

export function isScreenshotServiceConfigured(): boolean {
  return (env.SCREENSHOT_SERVICE_URL ?? '') !== '' && (env.SCREENSHOT_SERVICE_KEY ?? '') !== '';
}

export async function takeScreenshots(
  input: { url?: string; html?: string; devices: ShotDevice[]; fullPage?: boolean },
): Promise<{ images: ShotImage[]; title: string; finalUrl: string }> {
  if (!isScreenshotServiceConfigured()) throw new Error('The screenshot service is not configured.');
  const response = await fetch(`${env.SCREENSHOT_SERVICE_URL!.replace(/\/+$/, '')}/shot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shot-key': env.SCREENSHOT_SERVICE_KEY! },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(SHOT_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as { images?: ShotImage[]; title?: string; finalUrl?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Screenshot failed (${response.status.toString()})`);
  return { images: body.images ?? [], title: body.title ?? '', finalUrl: body.finalUrl ?? input.url ?? '' };
}
