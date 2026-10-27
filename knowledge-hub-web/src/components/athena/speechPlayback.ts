export interface SpeechAudio {
  audioBase64: string;
  mimeType: string;
}

type SynthesisOutcome = { audio: SpeechAudio; error?: never } | { audio?: never; error: unknown };
export type SpeechPlaybackAudio = Pick<HTMLAudioElement, 'volume' | 'src' | 'play' | 'pause' | 'addEventListener' | 'removeEventListener'>;

/** Keep one chunk ahead without allowing a failed chunk to disappear from the reply. */
export async function playSpeechChunks(
  chunks: string[],
  synthesize: (text: string, signal: AbortSignal) => Promise<SpeechAudio>,
  signal: AbortSignal,
  onAudio: (audio: SpeechPlaybackAudio | null) => void,
  createAudio: (source: string) => SpeechPlaybackAudio = source => new Audio(source),
): Promise<void> {
  async function prepare(text: string): Promise<SynthesisOutcome> {
    try {
      let audio: SpeechAudio;
      try {
        signal.throwIfAborted();
        audio = await synthesize(text, signal);
      } catch {
        signal.throwIfAborted();
        audio = await synthesize(text, signal);
      }
      if (!audio.audioBase64.trim() || !audio.mimeType.startsWith('audio/')) {
        throw new Error('The speech service returned no playable audio.');
      }
      return { audio };
    } catch (error) {
      // Capture a prefetched failure now; surface it when its turn arrives.
      return { error };
    }
  }

  const first = chunks[0];
  let pending = first !== undefined ? prepare(first) : undefined;
  for (let index = 0; pending !== undefined; index++) {
    const outcome = await pending;
    signal.throwIfAborted();
    if ('error' in outcome) throw outcome.error;
    const next = chunks[index + 1];
    pending = next !== undefined ? prepare(next) : undefined;
    const audio = createAudio(`data:${outcome.audio.mimeType};base64,${outcome.audio.audioBase64}`);
    onAudio(audio);
    let cleanup = (): void => {};
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { reject(signal.reason); };
        const finish = (error?: unknown): void => {
          signal.removeEventListener('abort', abort);
          if (error !== undefined) reject(error);
          else resolve();
        };
        const ended = (): void => { finish(); };
        const failed = (): void => { finish(new Error('Audio playback failed. The spoken reply was stopped, not skipped.')); };
        audio.addEventListener('ended', ended);
        audio.addEventListener('error', failed);
        cleanup = () => {
          signal.removeEventListener('abort', abort);
          audio.removeEventListener('ended', ended);
          audio.removeEventListener('error', failed);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        void audio.play().catch(finish);
      });
    } finally {
      cleanup();
      audio.pause();
      audio.src = '';
      onAudio(null);
    }
  }
}
