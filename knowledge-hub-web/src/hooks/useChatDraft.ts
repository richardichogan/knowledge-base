import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export function readChatDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch (error) {
    console.warn('[chat] Unable to restore the chat draft.', error);
    return '';
  }
}

export function writeChatDraft(key: string, value: string): boolean {
  try {
    if (value === '') window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn('[chat] Unable to persist the chat draft.', error);
    return false;
  }
}

/** Save on each edit, not after render: a login navigation can happen immediately. */
export function useChatDraft(key: string): [string, (value: React.SetStateAction<string>) => void, (nextKey: string) => void] {
  const [input, setInput] = useState(() => readChatDraft(key));
  const current = useRef({ key, input });
  useLayoutEffect(() => {
    if (current.current.key === key) return;
    const restored = readChatDraft(key);
    current.current = { key, input: restored };
    setInput(restored);
  }, [key]);
  const update = useCallback((value: React.SetStateAction<string>) => {
    const next = typeof value === 'function' ? value(current.current.input) : value;
    current.current.input = next;
    writeChatDraft(current.current.key, next);
    setInput(next);
  }, []);
  const move = useCallback((nextKey: string) => {
    if (nextKey === current.current.key) return;
    if (writeChatDraft(nextKey, current.current.input)) writeChatDraft(current.current.key, '');
    current.current.key = nextKey;
  }, []);
  return [input, update, move];
}
