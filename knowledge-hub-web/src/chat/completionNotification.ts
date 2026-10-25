export const LONG_PROMPT_MS = 30_000;
const notifiedTurns = new Set<string>();

export function requestCompletionNotifications(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  void Notification.requestPermission().catch((error: unknown) => {
    console.warn('Athena could not request completion notification permission.', error);
  });
}

export function notifyPromptCompleted(turnId: string, startedAt: number, sessionId: string, noteId?: string): void {
  if (!Number.isFinite(startedAt) || Date.now() - startedAt <= LONG_PROMPT_MS || notifiedTurns.has(turnId)
    || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification('Athena — Your reply is ready', {
      body: 'Your longer-running prompt has finished. Click to return to the conversation.',
      tag: `athena-reply-${turnId}`,
    });
    notifiedTurns.add(turnId);
    notification.onclick = () => {
      window.focus();
      window.location.assign(noteId === undefined ? `/chat?session=${encodeURIComponent(sessionId)}`
        : `/think?view=notes&noteId=${encodeURIComponent(noteId)}`);
      notification.close();
    };
    notification.onerror = event => { console.warn('Athena completion notification could not be displayed.', event); };
  } catch (error) {
    console.warn('Athena completion notification could not be created.', error);
  }
}

/** Desktop notification when a long-running Athena job (over 30s) finishes; clicking returns to `url`. */
export function notifyAthenaJobFinished(tag: string, startedAt: number, title: string, body: string, url: string): void {
  if (Date.now() - startedAt <= LONG_PROMPT_MS || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      if (`${window.location.pathname}${window.location.search}` !== url) window.location.assign(url);
      notification.close();
    };
    notification.onerror = event => { console.warn('Athena job notification could not be displayed.', event); };
  } catch (error) {
    console.warn('Athena job notification could not be created.', error);
  }
}
