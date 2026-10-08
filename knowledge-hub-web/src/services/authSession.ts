const listeners = new Set<() => void>();
let expired = false;

export class SessionExpiredError extends Error {
  constructor() {
    super('Your sign-in has expired. Re-authenticate to continue.');
    this.name = 'SessionExpiredError';
  }
}

export const authSession = {
  isExpired: (): boolean => expired,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  setExpired(value: boolean): void {
    if (expired === value) return;
    expired = value;
    for (const listener of listeners) listener();
  },
};
