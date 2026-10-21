export function finishVoiceTranscript(
  text: string,
  reviewOnly: boolean,
  review: (text: string) => void,
  send: (text: string) => void,
): void {
  const transcript = text.trim();
  if (!transcript) throw new Error('No speech was detected. Your existing draft is unchanged.');
  if (reviewOnly) review(transcript);
  else send(transcript);
}

export function appendVoiceTranscript(draft: string, transcript: string): string {
  return draft.trim() ? `${draft}\n${transcript}` : transcript;
}
