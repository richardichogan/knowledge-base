import type { Request, Response, NextFunction } from 'express';
import { createPublicKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { UnauthorisedError } from '../types/errors.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
}

// ── Microsoft Entra (Alliance tenant) access tokens ──────────────────────────

const ENTRA_SCOPE = 'access_as_user';
const JWKS_REFRESH_MS = 21_600_000; // 6 hours
// A token signed with a key we haven't seen triggers a refetch, but not more often than this.
const JWKS_MIN_REFETCH_MS = 60_000;

function entraClientId(): string | undefined {
  return env.ATHENA_AUTH_CLIENT_ID ?? env.ALLIANCE_GRAPH_CLIENT_ID;
}

function entraTenantId(): string | undefined {
  return env.ATHENA_AUTH_TENANT_ID ?? env.ALLIANCE_GRAPH_TENANT_ID;
}

let signingKeys = new Map<string, KeyObject>();
let keysFetchedAt = 0;

async function loadSigningKeys(tenantId: string): Promise<void> {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
  if (!res.ok) throw new Error(`Entra signing keys: HTTP ${res.status.toString()}`);
  const body = (await res.json()) as { keys: Array<{ kid: string; kty: string; n: string; e: string }> };
  const next = new Map<string, KeyObject>();
  for (const k of body.keys) {
    if (k.kty !== 'RSA') continue;
    next.set(k.kid, createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: 'jwk' }));
  }
  signingKeys = next;
  keysFetchedAt = Date.now();
}

async function signingKey(tenantId: string, kid: string): Promise<KeyObject | undefined> {
  const age = Date.now() - keysFetchedAt;
  if (age > JWKS_REFRESH_MS || (!signingKeys.has(kid) && age > JWKS_MIN_REFETCH_MS)) {
    await loadSigningKeys(tenantId);
  }
  return signingKeys.get(kid);
}

interface EntraClaims {
  oid?: string;
  tid?: string;
  scp?: string;
  preferred_username?: string;
}

function isAllowedUser(claims: EntraClaims): boolean {
  const ids = (env.ATHENA_ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  if (claims.oid !== undefined && ids.includes(claims.oid.toLowerCase())) return true;
  const upn = env.ALLIANCE_ALLOWED_UPN?.trim().toLowerCase();
  return upn !== undefined && upn !== '' && claims.preferred_username?.toLowerCase() === upn;
}

/**
 * Verifies a Microsoft Entra access token issued for this app's API.
 * Returns the user's object id, or null if the token isn't an Entra token
 * (so the caller can try the legacy app token instead). Throws if it is an
 * Entra token but invalid or for someone not allowed in.
 */
async function verifyEntraToken(token: string): Promise<string | null> {
  const clientId = entraClientId();
  const tenantId = entraTenantId();
  if (clientId === undefined || tenantId === undefined) return null;
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header.kid;
  if (decoded === null || kid === undefined) return null;
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  if ((decoded.payload as { iss?: string }).iss !== issuer) return null;

  const key = await signingKey(tenantId, kid);
  if (key === undefined) throw new UnauthorisedError('Unknown token signing key');
  const claims = jwt.verify(token, key, { algorithms: ['RS256'], issuer, audience: clientId }) as EntraClaims;
  if (claims.tid !== tenantId) throw new UnauthorisedError('Wrong tenant');
  if (!(claims.scp ?? '').split(' ').includes(ENTRA_SCOPE)) throw new UnauthorisedError('Missing API scope');
  if (!isAllowedUser(claims)) throw new UnauthorisedError('This account is not allowed to use Athena');
  return claims.oid ?? 'entra-user';
}

/**
 * Authentication middleware for /api.
 * Accepts a Microsoft Entra access token (the web app, via MSAL) or the
 * legacy app token signed with JWT_SECRET (Raycast / mobile app).
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  // Admin cron routes authenticate via x-cron-secret — skip JWT for these
  if (req.path.includes('/admin/')) {
    return next();
  }

  // In development or when SKIP_AUTH is set, bypass JWT so the UI works without login
  if (env.NODE_ENV === 'development' || process.env.SKIP_AUTH === 'true') {
    (req as AuthenticatedRequest).userId = 'dev-user';
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorisedError('Missing or malformed Authorization header'));
  }

  const token = authHeader.substring('Bearer '.length);

  void (async (): Promise<void> => {
    try {
      const entraUser = await verifyEntraToken(token);
      if (entraUser !== null) {
        (req as AuthenticatedRequest).userId = entraUser;
        next();
        return;
      }
      const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
      (req as AuthenticatedRequest).userId = payload.sub;
      next();
    } catch (err) {
      next(err instanceof UnauthorisedError ? err : new UnauthorisedError('Invalid or expired token'));
    }
  })();
}
