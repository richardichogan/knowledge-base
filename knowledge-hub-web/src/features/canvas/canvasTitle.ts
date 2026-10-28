/** An empty title is a valid, persisted idea; undefined means no change. */
export function ideaTitleChange(previous: string | null, draft: string, save: boolean): string | undefined {
  if (!save) return undefined;
  const title = draft.trim();
  return title === (previous ?? '') ? undefined : title;
}
