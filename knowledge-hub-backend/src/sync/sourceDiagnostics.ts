export interface SyncFailure {
  target: string;
  code: 'expired-credential' | 'access-denied' | 'not-found-or-inaccessible' | 'invalid-document' | 'incomplete-tree' | 'source-error';
  action: string;
}

const MAX_FAILURES = 20;
const MAX_TARGET_CHARS = 300;
const MAX_SUMMARY_CHARS = 4000;

/** Persist actionable categories, never raw provider bodies or document content. */
export function sourceFailure(target: string, error: unknown): SyncFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = /key has expired/i.test(message) ? 'expired-credential'
    : /\b403\b/.test(message) ? 'access-denied'
      : /\b404\b/.test(message) ? 'not-found-or-inaccessible'
        : /encoding|document contains|decode/i.test(message) ? 'invalid-document' : 'source-error';
  const action = code === 'expired-credential' ? 'Replace the expired credential in Connections.'
    : code === 'access-denied' ? 'Check consent and access permissions for this source.'
      : code === 'not-found-or-inaccessible' ? 'Verify the configured name and the integration account access; a private source may return 404.'
        : code === 'invalid-document' ? 'Check the original document encoding; no content was discarded.'
          : 'Inspect the source logs and retry after correcting the provider or indexing error.';
  return { target: target.slice(0, MAX_TARGET_CHARS), code, action };
}

export function addSourceFailure(failures: SyncFailure[], target: string, error: unknown): void {
  if (failures.length < MAX_FAILURES) failures.push(sourceFailure(target, error));
}

export function syncFailureSummary(errors: number, failures: SyncFailure[]): string | null {
  return errors ? `${errors} errors. ${failures.map(f => `${f.target}: ${f.code}. ${f.action}`).join(' ')}`.slice(0, MAX_SUMMARY_CHARS) : null;
}
