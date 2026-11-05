let presented: { noteId: string; issue: string | null } | null = null;

export function recordPresentedVisuals(noteId: string, issue: string | null): void {
  presented = { noteId, issue };
}
export function presentedVisualIssue(noteId: string): string | null {
  return presented?.noteId === noteId ? presented.issue : null;
}
