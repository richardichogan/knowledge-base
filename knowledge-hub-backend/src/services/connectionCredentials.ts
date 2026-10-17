import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { connectionCredentials, replaceCredentialValues, setCredentialValue, type CredentialName } from '../config/credentialValues.js';
import { EXTERNAL_FETCH_TIMEOUT_MS } from '../config/constants.js';
import { ConfigurationError, IntegrationError, NotFoundError, ValidationError } from '../types/errors.js';

const PREFIX = 'connection-credential:';

function encryptionKey(): Buffer {
  const secret = env.CREDENTIAL_ENCRYPTION_KEY ?? env.GRAPH_CLIENT_SECRET;
  if (!secret || secret.length < 32) throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY (at least 32 characters)');
  return createHash('sha256').update(`athena-connection-credentials:${secret}`).digest();
}

function encrypt(name: CredentialName, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(name: CredentialName, encoded: string): string {
  try {
    const raw = Buffer.from(encoded, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new ConfigurationError(`Unable to decrypt saved ${name}; restore the original CREDENTIAL_ENCRYPTION_KEY / Graph client secret`);
  }
}

export async function loadConnectionCredentials(db: Pool): Promise<void> {
  const result = await db.query<{ source: string; last_cursor: string }>(
    'SELECT source, last_cursor FROM sync_state WHERE source LIKE $1', [`${PREFIX}%`],
  );
  const values = new Map<CredentialName, string>();
  for (const entry of connectionCredentials) {
    const row = result.rows.find((r) => r.source === `${PREFIX}${entry.id}`);
    if (row !== undefined) values.set(entry.envKey, decrypt(entry.envKey, row.last_cursor));
  }
  replaceCredentialValues(values);
}

export async function listConnectionCredentials(db: Pool) {
  await loadConnectionCredentials(db);
  const result = await db.query<{ source: string; updated_at: Date }>(
    'SELECT source, updated_at FROM sync_state WHERE source LIKE $1', [`${PREFIX}%`],
  );
  return connectionCredentials
    // Hide keys for features that have no endpoint configured; a key alone would not enable them.
    .filter((entry) => !('requiresKey' in entry) || Boolean(env[entry.requiresKey]))
    .map((entry) => {
      const own = Boolean(env[entry.envKey]);
      const fallback = !own && 'fallbackKey' in entry && Boolean(env[entry.fallbackKey]);
      return {
        id: entry.id,
        name: entry.name,
        detail: entry.detail,
        ...('helpUrl' in entry ? { helpUrl: entry.helpUrl } : {}),
        configured: own || fallback,
        usingFallback: fallback && 'fallbackName' in entry ? entry.fallbackName : null,
        updatedAt: result.rows.find((r) => r.source === `${PREFIX}${entry.id}`)?.updated_at.toISOString() ?? null,
      };
    });
}

async function checkToken(id: string, value: string): Promise<boolean> {
  if (id !== 'gitlab' && id !== 'github' && id !== 'github-agents') return false;
  const isGitlab = id === 'gitlab';
  const url = isGitlab ? `${env.GITLAB_BASE_URL.replace(/\/$/, '')}/api/v4/user` : 'https://api.github.com/user';
  const headers: Record<string, string> = isGitlab
    ? { 'PRIVATE-TOKEN': value }
    : { Authorization: `Bearer ${value}`, Accept: 'application/vnd.github+json' };
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new IntegrationError(id, 'Could not reach the provider to verify the token. The previous credential has not been changed.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ValidationError('The provider rejected this token. Check its expiry, permissions and organisation access. The previous credential has not been changed.');
  }
  if (!response.ok) throw new IntegrationError(id, `Token verification failed (HTTP ${response.status}). The previous credential has not been changed.`);
  return true;
}

export async function updateConnectionCredential(db: Pool, id: string, input: unknown): Promise<{ verified: boolean }> {
  const entry = connectionCredentials.find((c) => c.id === id);
  if (entry === undefined) throw new NotFoundError('Token connection');
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 8192 || /[\r\n\0]/.test(input)) {
    throw new ValidationError('Enter a non-empty token or API key (maximum 8,192 characters, no line breaks).');
  }
  const value = input.trim();
  const encrypted = encrypt(entry.envKey, value);
  const verified = await checkToken(id, value);
  await db.query(
    `INSERT INTO sync_state (source, last_cursor, item_count, updated_at)
     VALUES ($1, $2, 0, NOW())
     ON CONFLICT (source) DO UPDATE SET last_cursor = EXCLUDED.last_cursor, updated_at = NOW()`,
    [`${PREFIX}${id}`, encrypted],
  );
  setCredentialValue(entry.envKey, value);
  return { verified };
}
