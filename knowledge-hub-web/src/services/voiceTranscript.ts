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

/** What Athena says aloud for a reply, mentioning any approval waiting on screen. */
export function spokenReply(plainReply: string, approvalsWaiting: number): string {
  const note = approvalsWaiting === 0 ? ''
    : approvalsWaiting === 1 ? 'There is an approval waiting for you on screen.'
      : `There are ${String(approvalsWaiting)} approvals waiting for you on screen.`;
  return [plainReply.trim(), note].filter(Boolean).join(' ');
}
