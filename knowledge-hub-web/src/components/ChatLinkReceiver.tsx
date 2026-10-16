/**
 * Opens Athena chat links in the chat window that is already open, instead of a new one:
 * - Athena Desktop sends them over the desktop bridge (athena-desktop/src/main.ts).
 * - The installed PWA receives them through the launch queue (manifest launch_handler "focus-existing").
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDesktop } from '../types/desktop';

interface LaunchParams { targetURL?: string }
interface LaunchQueue { setConsumer(consumer: (params: LaunchParams) => void): void }

export function chatPathFrom(url: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || parsed.pathname !== '/chat') return null;
  return `${parsed.pathname}${parsed.search}`;
}

export function ChatLinkReceiver(): null {
  const navigate = useNavigate();
  useEffect(() => {
    const open = (url: string): void => {
      const path = chatPathFrom(url, window.location.origin);
      if (path !== null) navigate(path);
    };
    const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
    launchQueue?.setConsumer((params) => { if (params.targetURL) open(params.targetURL); });
    return getDesktop()?.onOpenChat?.(open);
  }, [navigate]);
  return null;
}
