import { useEffect, useRef } from 'react';
import type { DesktopCommand } from '../types/desktop';

type Handler = () => Promise<void>;
const handlers = new Map<DesktopCommand, Handler>();
export function useDesktopCommand(command: DesktopCommand, handler: Handler): void {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    const invoke = (): Promise<void> => current.current();
    handlers.set(command, invoke);
    return () => { if (handlers.get(command) === invoke) handlers.delete(command); };
  }, [command]);
}
export async function runDesktopCommand(command: DesktopCommand): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!handlers.has(command) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  const handler = handlers.get(command);
  if (!handler) throw new Error('This action is not ready. Sign in and open Athena, then try again.');
  await handler();
}
