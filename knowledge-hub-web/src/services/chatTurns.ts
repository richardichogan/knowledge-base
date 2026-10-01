/**
 * services/chatTurns.ts — sends a chat message as a background turn on the
 * server and follows it live (activity lines, streamed text) until it's done.
 * The turn keeps running if the browser drops the connection, refreshes or
 * leaves; following reconnects quietly, and the answer is saved to the chat.
 */
import { api, readChatTurnEvents } from './api';
import type { ApiResponse, ChatRequest, ChatResponse, ChatTurnEvent } from '../types';

export interface LiveTurnHandlers {
  /** The server accepted the turn (the session id is known from here on). */
  onStarted?: (turnId: string, sessionId: string) => void;
  onActivity: (line: string) => void;
  /** The answer streamed so far (replaces the previous value). */
  onText: (text: string) => void;
}

/** Stop was pressed: the turn was stopped on the server. */
export class TurnStoppedError extends Error {
  constructor() { super('Stopped'); this.name = 'CanceledError'; }
}

/** The view stopped following (e.g. switched chats); the turn carries on and lands in its chat. */
export class TurnDetachedError extends Error {
  constructor() { super('Detached'); this.name = 'TurnDetachedError'; }
}

const MAX_RECONNECTS = 40;
const RECONNECT_DELAY_MS = 1_500;

export async function sendChatTurn(
  request: ChatRequest,
  handlers: LiveTurnHandlers,
  signal: AbortSignal,
): Promise<ApiResponse<ChatResponse>> {
  const start = await api.startChatTurn(request);
  if (!start.success) return start;
  handlers.onStarted?.(start.data.turnId, start.data.sessionId);
  return followChatTurn(start.data.turnId, handlers, signal);
}

/** Follows a running turn to its end. Rejects with TurnStoppedError or TurnDetachedError. */
export async function followChatTurn(
  turnId: string,
  handlers: LiveTurnHandlers,
  signal: AbortSignal,
): Promise<ApiResponse<ChatResponse>> {
  let text = '';
  for (let attempt = 0; attempt < MAX_RECONNECTS; attempt++) {
    let outcome: ChatTurnEvent | null = null;
    try {
      await readChatTurnEvents(turnId, (e) => {
        if (e.type === 'snapshot') {
          text = e.text;
          handlers.onText(text);
          handlers.onActivity(e.activity);
        } else if (e.type === 'delta') {
          text += e.text;
          handlers.onText(text);
        } else if (e.type === 'reset') {
          text = '';
          handlers.onText('');
        } else if (e.type === 'activity') {
          handlers.onActivity(e.text);
        } else {
          outcome = e;
        }
      }, signal);
    } catch {
      // Dropped connection: reconnect below, unless the view let go.
    }
    if (signal.aborted) throw new TurnDetachedError();
    const ended = outcome as ChatTurnEvent | null;
    if (ended?.type === 'done') return { success: true, data: ended.data };
    if (ended?.type === 'error') {
      if (ended.stopped) throw new TurnStoppedError();
      return { success: false, error: { code: 'AI_ERROR', message: ended.message } };
    }
    if (ended?.type === 'gone') {
      return { success: false, error: { code: 'TURN_GONE', message: 'That answer finished while you were away — it is saved in this chat.' } };
    }
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
  }
  return { success: false, error: { code: 'TURN_LOST', message: 'Lost touch with that answer. It will appear in this chat when it is ready — reopen the chat in a minute.' } };
}
