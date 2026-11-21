import { noteDraftKey } from './noteDraftStorage';

const PREFIX = 'athena-note-editor:';

export interface EditorIdentity {
  id: string;
  registrationId: string;
  hasRecovery: () => boolean;
  release: (closed: boolean) => void;
}

export async function acquireEditorIdentities(noteId: string, owner: string, draftId: string): Promise<EditorIdentity[]> {
  const prefix = `${PREFIX}${encodeURIComponent(owner)}:${encodeURIComponent(noteId)}:`;
  const held: EditorIdentity[] = [];
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  const acquire = async (id: string, existing: boolean): Promise<void> => {
    let unlock = (): void => {};
    if (navigator.locks) {
      const release = await new Promise<(() => void) | null>((resolve, reject) => {
        void navigator.locks.request(`${PREFIX}${id}`, { ifAvailable: true }, async lock => {
          if (!lock) { resolve(null); return; }
          await new Promise<void>(done => resolve(done));
        }).catch(reject);
      });
      if (!release) return;
      unlock = release;
    } else if (existing) return;
    const key = `${prefix}${id}`;
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('Invalid editor recovery identity.');
      const draftIds = [...new Set([...parsed, draftId])];
      localStorage.setItem(key, JSON.stringify(draftIds));
      held.push({
        id,
        registrationId: crypto.randomUUID(),
        hasRecovery: () => draftIds.some(value => localStorage.getItem(noteDraftKey(owner, noteId, value)) !== null),
        release: closed => { try { if (closed) localStorage.removeItem(key); } finally { unlock(); } },
      });
    } catch (error) { unlock(); throw error; }
  };
  try {
    for (const key of keys) await acquire(key.slice(prefix.length), true);
    await acquire(crypto.randomUUID(), false);
    return held;
  } catch (error) {
    held.forEach(identity => identity.release(false));
    throw error;
  }
}
