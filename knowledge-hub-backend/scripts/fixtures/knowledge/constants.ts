import { createHash } from 'node:crypto';

/** Pinned clock for every knowledge fixture and evaluation (spec section 10). */
export const PINNED_NOW_ISO = '2026-10-22T09:00:00Z';
export const PINNED_NOW = new Date(PINNED_NOW_ISO);
export const FIXTURE_TIMEZONE = 'Europe/London';

/** Appears only in deliberately excluded metadata; it must never reach tool output, model requests or logs. */
export const SECRET_CANARY = 'secret-canary-DO-NOT-EXPOSE';

export const PROJECT_IMAGINE = 'p-imagine';
export const PROJECT_INDEPENDENT = 'p-independent';

export interface FixtureProject {
  id: string;
  uuid: string;
  name: string;
  visibility: 'private' | 'independent';
  goal: string;
  targetDate: string;
}

/** Deterministic RFC 4122 version-5-shaped UUID so fixtures keep stable identities across runs. */
export function stableUuid(label: string): string {
  const h = createHash('sha1').update(`athena-knowledge-fixture:${label}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const FIXTURE_PROJECTS: readonly FixtureProject[] = [
  {
    id: PROJECT_IMAGINE, uuid: stableUuid(PROJECT_IMAGINE), name: 'IMAGINE', visibility: 'private',
    goal: 'Insurance claims workforce', targetDate: '2026-11-30',
  },
  {
    id: PROJECT_INDEPENDENT, uuid: stableUuid(PROJECT_INDEPENDENT), name: 'Independent', visibility: 'independent',
    goal: 'Independent public work and outputs', targetDate: '2026-12-31',
  },
];

/** Seeded PRNG (mulberry32): the only randomness permitted in fixture and benchmark generation. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
