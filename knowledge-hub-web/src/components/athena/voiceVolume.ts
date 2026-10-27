import { useSyncExternalStore } from 'react';
import { readStored, writeStored } from '../../hooks/usePersistedState';

const STORAGE_KEY = 'kh-athena-voice-volume';
export const MAX_VOICE_VOLUME = 100;
let volume: number | undefined;
const listeners = new Set<() => void>();

export function parseVoiceVolume(raw: string | null): number {
  const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_VOICE_VOLUME
    ? Math.round(parsed) : MAX_VOICE_VOLUME;
}

export function getVoiceVolume(): number {
  volume ??= parseVoiceVolume(readStored(STORAGE_KEY));
  return volume;
}

function setVoiceVolume(next: number): void {
  if (!Number.isFinite(next) || next < 0 || next > MAX_VOICE_VOLUME) throw new Error('Volume must be between 0 and 100.');
  volume = Math.round(next);
  writeStored(STORAGE_KEY, String(volume));
  listeners.forEach(listener => { listener(); });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    volume = parseVoiceVolume(event.newValue);
    listeners.forEach(notify => { notify(); });
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

export function useVoiceVolume(): [number, (next: number) => void] {
  return [useSyncExternalStore(subscribe, getVoiceVolume, () => MAX_VOICE_VOLUME), setVoiceVolume];
}
