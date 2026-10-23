import { useCallback, useEffect, useState } from 'react';
import { athenaMarkState, type AthenaMotionPhase } from './athenaMotion';

export const ATHENA_MOODS = ['resting', 'listening', 'thinking', 'answering', 'happy', 'curious', 'unsure', 'sorry', 'excited'] as const;
export type AthenaMood = typeof ATHENA_MOODS[number];
export type AthenaEmotion = 'happy' | 'curious' | 'unsure' | 'sorry' | 'excited';
export interface AthenaEmotionEvent { mood: AthenaEmotion; startsAt: number; endsAt: number; context: string }

export function resolveAthenaMood(phase: AthenaMotionPhase, emotion: AthenaEmotionEvent | null, context: string, now: number): AthenaMood {
  if (phase !== 'idle') return athenaMarkState(phase);
  return emotion?.context === context && now >= emotion.startsAt && now < emotion.endsAt ? emotion.mood : 'resting';
}

export function useAthenaMood(phase: AthenaMotionPhase, context: string) {
  const [emotion, setEmotion] = useState<AthenaEmotionEvent | null>(null);
  const [now, setNow] = useState(Date.now);
  const emote = useCallback((mood: AthenaEmotion, delay = 0): void => {
    const time = Date.now();
    setNow(time);
    setEmotion({ mood, context, startsAt: time + delay, endsAt: time + delay + 2500 });
  }, [context]);
  const clearEmotion = useCallback(() => { setEmotion(null); }, []);
  useEffect(() => {
    if (emotion?.context !== context) return;
    const time = Date.now();
    const next = time < emotion.startsAt ? emotion.startsAt : emotion.endsAt;
    const timer = window.setTimeout(() => {
      setNow(Date.now());
      if (Date.now() >= emotion.endsAt) setEmotion(null);
    }, Math.max(0, next - time));
    return () => { window.clearTimeout(timer); };
  }, [emotion, context, now]);
  return { mood: resolveAthenaMood(phase, emotion, context, Date.now()), emote, clearEmotion };
}
