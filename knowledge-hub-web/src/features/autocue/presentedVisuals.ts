let presented: { noteId: string; issue: string | null } | null = null;

export function recordPresentedVisuals(noteId: string, issue: string | null): void {
  presented = { noteId, issue };
}
export function presentedVisualIssue(noteId: string): string | null {
  return presented?.noteId === noteId ? presented.issue : null;
}

export async function openPresentationVisuals(start: () => Promise<void>, issue: () => string | null,
  open: () => Promise<void>): Promise<void> {
  await start();
  const error = issue();
  if (error) throw new Error(error);
  await open();
}
