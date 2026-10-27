import { useEffect, useRef } from 'react';
import type { DesktopCommand } from '../types/desktop';

type Handler = () => Promise<void>;
interface Registration { invoke: Handler; available: () => boolean }
const handlers = new Map<DesktopCommand, Set<Registration>>();
export function useDesktopCommand(command: DesktopCommand, handler: Handler, available: () => boolean = () => true): void {
  const current = useRef({ handler, available });
  current.current = { handler, available };
  useEffect(() => {
    const registration = { invoke: (): Promise<void> => current.current.handler(), available: () => current.current.available() };
    const entries = handlers.get(command) ?? new Set<Registration>();
    entries.add(registration);
    handlers.set(command, entries);
    return () => {
      entries.delete(registration);
      if (entries.size === 0) handlers.delete(command);
    };
  }, [command]);
}
export async function runDesktopCommand(command: DesktopCommand): Promise<void> {
  const deadline = Date.now() + 8000;
  do {
    const handler = Array.from(handlers.get(command) ?? []).reverse().find(entry => entry.available());
    if (handler) { await handler.invoke(); return; }
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error('This action is not ready. Sign in and open Athena, then try again.');
}
