export const ELGATO_PORT = 43129;
export const COMMANDS = [
  'open-athena', 'new-note', 'new-diagram', 'speak', 'present-note',
  'play', 'pause', 'toggle-play', 'stop', 'faster', 'slower', 'text-larger', 'text-smaller',
] as const;
export type DesktopCommand = typeof COMMANDS[number];
export interface CommandRequest { id: string; command: DesktopCommand; issuedAt: number }
export interface PresentationState {
  sessionId: string;
  title: string;
  status: 'ready' | 'playing' | 'paused' | 'ended' | 'disconnected';
  speed: number;
  fontSize: number;
  progress: number;
  displayId: number | null;
  mirror: boolean;
  flip: boolean;
  error: string | null;
}
export interface PresentationScript { noteId: string; title: string; text: string }
export interface PresentationDisplay {
  id: number; label: string; width: number; height: number; scale: number; primary: boolean;
}
export interface DesktopCommandState {
  protocol: 1;
  presentation: PresentationState;
  recording: boolean;
  transcribing: boolean;
  error: string | null;
}
export function parseCommand(value: unknown, now = Date.now()): CommandRequest {
  if (!value || typeof value !== 'object') throw new Error('A command object is required.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['id', 'command', 'issuedAt'].includes(k))
    || typeof v.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(v.id)
    || typeof v.command !== 'string' || !COMMANDS.some(c => c === v.command)
    || typeof v.issuedAt !== 'number' || !Number.isFinite(v.issuedAt)
    || Math.abs(now - v.issuedAt) > 30_000) throw new Error('Unknown, invalid or expired command.');
  return { id: v.id, command: v.command as DesktopCommand, issuedAt: v.issuedAt };
}
export function initialPresentation(): PresentationState {
  return { sessionId: '', title: '', status: 'ready', speed: 80, fontSize: 64,
    progress: 0, displayId: null, mirror: false, flip: false, error: null };
}
export function playbackCommand(state: PresentationState, command: DesktopCommand): PresentationState {
  const next = { ...state, error: null };
  switch (command) {
    case 'play': case 'toggle-play':
      if (state.displayId === null || !state.sessionId) throw new Error('Choose a script and connect an output display first.');
      next.status = command === 'toggle-play' && state.status === 'playing' ? 'paused' : 'playing';
      if (state.status === 'ended' || state.progress >= 1) next.progress = 0;
      break;
    case 'pause': next.status = 'paused'; break;
    case 'stop': next.status = 'ready'; next.progress = 0; break;
    case 'faster': next.speed = Math.min(300, state.speed + 10); break;
    case 'slower': next.speed = Math.max(10, state.speed - 10); break;
    case 'text-larger': next.fontSize = Math.min(96, state.fontSize + 4); break;
    case 'text-smaller': next.fontSize = Math.max(24, state.fontSize - 4); break;
    default: throw new Error('Not a playback command.');
  }
  return next;
}
