/**
 * seed-cert-programme.ts
 *
 * Runner script for the cert_programmes / cert_sessions seed.
 * Usage: npx tsx scripts/seed-cert-programme.ts
 */
import 'dotenv/config';
import { getDb } from '../src/db/db.js';
import { seedCertProgramme } from '../src/seeds/cert-programme.js';

async function main() {
  const db = getDb();
  console.warn('Seeding cert programmes and sessions…');
  await seedCertProgramme(db);
  console.warn('Done.');
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
