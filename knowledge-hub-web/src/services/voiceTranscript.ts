export async function finishVoiceTranscript(
  text: string,
  reviewOnly: boolean,
  review: (text: string) => void,
  send: (text: string) => Promise<void>,
): Promise<void> {
  const transcript = text.trim();
  if (!transcript) throw new Error('No speech was detected. Your existing draft is unchanged.');
  if (reviewOnly) review(transcript);
  else await send(transcript);
}

export function appendVoiceTranscript(draft: string, transcript: string): string {
  return draft.trim() ? `${draft}\n${transcript}` : transcript;
}

export async function submitVoiceTranscript(
  transcript: string, draft: string, canSend: boolean,
  keepDraft: (message: string) => void, send: (message: string) => Promise<void>,
): Promise<void> {
  if (!transcript.trim()) throw new Error('No speech was detected. Your existing draft is unchanged.');
  const message = appendVoiceTranscript(draft, transcript.trim());
  keepDraft(message);
  if (!canSend) throw new Error('Chat is not ready to send. The transcript is in your draft; review it and press Send.');
  await send(message);
}
