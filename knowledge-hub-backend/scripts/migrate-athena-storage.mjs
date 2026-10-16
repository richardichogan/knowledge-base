/**
 * Non-destructive Athena-only storage cutover.
 * Credentials arrive through environment variables, never arguments or files.
 * Run inventory, copy, then rewrite after the app's storage cutover, then verify.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  BlobServiceClient, BlobSASPermissions, SASProtocol, StorageSharedKeyCredential,
} from '@azure/storage-blob';
import pg from 'pg';

export const ATHENA_CONTAINERS = Object.freeze(['kb-documents', 'kb-images', 'chat-screens']);
const TABLES = new Set(['content_items', 'kb_images', 'notes', 'note_versions', 'ai_chat_messages', 'athena_feedback']);
const SOURCE = 'mscloudblogs2026';
const DESTINATION = 'khprodr6mgdnys';

export function athenaUrlPattern(account = SOURCE) {
  if (!/^[a-z0-9]+$/.test(account)) throw new Error('Invalid account name');
  return new RegExp(`https://${account}\\.blob\\.core\\.windows\\.net/(?:${ATHENA_CONTAINERS.join('|')})/[a-zA-Z0-9%._~/-]+(?:\\?[a-zA-Z0-9%&;=+_.:~-]*)?`, 'g');
}

export function replaceAthenaUrls(text, replacement, account = SOURCE) {
  return text.replace(athenaUrlPattern(account), replacement);
}

export function blobIdentity(url) {
  const parsed = new URL(url.replaceAll('&amp;', '&'));
  const [container, ...parts] = parsed.pathname.slice(1).split('/');
  if (!ATHENA_CONTAINERS.includes(container) || parts.length === 0) throw new Error('Not an Athena blob');
  return { container, name: decodeURIComponent(parts.join('/')) };
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function hashBlob(blob, etag) {
  const response = await blob.download(0, undefined, etag ? { conditions: { ifMatch: etag } } : {});
  if (!response.readableStreamBody) throw new Error('Blob download returned no stream');
  const hash = createHash('sha256');
  for await (const chunk of response.readableStreamBody) hash.update(chunk);
  return hash.digest('hex');
}

async function copyAndVerify(source, destination, copy) {
  const manifest = new Set();
  for (const name of ATHENA_CONTAINERS) {
    const from = source.getContainerClient(name);
    const to = destination.getContainerClient(name);
    if (!await from.exists()) continue;
    if (copy) await to.createIfNotExists();
    const privacy = await to.getProperties();
    if (privacy.blobPublicAccess) throw new Error(`Destination container ${name} must be private`);
    const blobs = [];
    for await (const blob of from.listBlobsFlat()) blobs.push(blob);
    let verified = 0;
    let bytes = 0;
    const queue = [...blobs];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        const original = from.getBlobClient(item.name);
        const target = to.getBlockBlobClient(item.name);
        if (!await target.exists()) {
          if (!copy) throw new Error(`Uncopied Athena blob in ${name}`);
          const readUrl = await original.generateSasUrl({
            permissions: BlobSASPermissions.parse('r'), protocol: SASProtocol.Https,
            expiresOn: new Date(Date.now() + 3_600_000),
          });
          const poller = await target.beginCopyFromURL(readUrl, {
            conditions: { ifNoneMatch: '*' }, sourceConditions: { ifMatch: item.properties.etag },
            intervalInMs: 1_000,
            abortSignal: AbortSignal.timeout(180_000),
          });
          const result = await poller.pollUntilDone();
          if (result.copyStatus !== 'success') throw new Error(`Copy did not succeed for ${name}`);
        }
        const props = await target.getProperties();
        if (props.contentLength !== item.properties.contentLength || props.contentType !== item.properties.contentType) {
          throw new Error(`Destination properties differ in ${name}; refusing overwrite`);
        }
        const [before, after] = await Promise.all([hashBlob(original, item.properties.etag), hashBlob(target, props.etag)]);
        if (before !== after) throw new Error(`SHA-256 mismatch in ${name}; refusing overwrite`);
        manifest.add(`${name}/${item.name}`);
        bytes += props.contentLength ?? 0;
        verified += 1;
        if (verified % 20 === 0) console.log(JSON.stringify({ container: name, verified, total: blobs.length }));
      }
    }));
    console.log(JSON.stringify({ container: name, verified, bytes, sha256: 'matched' }));
  }
  return manifest;
}

async function references(db) {
  const { rows: columns } = await db.query(`SELECT table_name, column_name, data_type
    FROM information_schema.columns WHERE table_schema = 'public'
    AND data_type IN ('text', 'character varying', 'jsonb', 'json') ORDER BY table_name, ordinal_position`);
  const result = [];
  for (const column of columns) {
    const table = identifier(column.table_name);
    const field = identifier(column.column_name);
    const count = await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${field}::text ~ $1`,
      [athenaUrlPattern().source]);
    if (count.rows[0].count === 0) continue;
    if (!TABLES.has(column.table_name)) throw new Error(`Unreviewed Athena references in ${column.table_name}.${column.column_name}`);
    const { rows } = await db.query(`SELECT id::text AS id, ${field} AS value FROM ${table}
      WHERE ${field}::text ~ $1`, [athenaUrlPattern().source]);
    if (column.table_name === 'content_items') {
      const { rows: unexpected } = await db.query(`SELECT DISTINCT source FROM content_items
        WHERE ${field}::text ~ $1 AND source NOT IN ('user-upload', 'note')`, [athenaUrlPattern().source]);
      if (unexpected.length > 0) throw new Error('Non-Athena content source contains an Athena URL; review required');
    }
    console.log(JSON.stringify({ table: column.table_name, column: column.column_name, references: rows.length }));
    result.push({ ...column, rows });
  }
  return result;
}

async function rewriteReferences(db, destination, manifest) {
  const { writingFingerprint } = await import('../src/services/noteVersionService.ts');
  const groups = await references(db);
  const replacements = new Map();
  for (const group of groups) {
    for (const row of group.rows) {
      const text = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
      for (const match of text.matchAll(athenaUrlPattern())) {
        const raw = match[0];
        if (replacements.has(raw)) continue;
        const identity = blobIdentity(raw);
        if (!manifest.has(`${identity.container}/${identity.name}`)) throw new Error('A database reference has no verified destination blob');
        const original = new URL(raw.replaceAll('&amp;', '&'));
        const expiry = original.searchParams.get('se');
        const expiresOn = expiry ? new Date(expiry) : new Date(Date.now() + 3_600_000);
        if (!Number.isFinite(expiresOn.getTime())) throw new Error('Invalid saved URL expiry');
        const blob = destination.getContainerClient(identity.container).getBlobClient(identity.name);
        const url = await blob.generateSasUrl({ permissions: BlobSASPermissions.parse('r'), protocol: SASProtocol.Https, expiresOn });
        replacements.set(raw, raw.includes('&amp;') ? url.replaceAll('&', '&amp;') : url);
      }
    }
  }
  await db.query('BEGIN');
  try {
    for (const group of groups) {
      const table = identifier(group.table_name);
      const field = identifier(group.column_name);
      const json = ['jsonb', 'json'].includes(group.data_type);
      for (const row of group.rows) {
        const before = json ? JSON.stringify(row.value) : row.value;
        const after = replaceAthenaUrls(before, (url) => {
          const replacement = replacements.get(url);
          if (!replacement) throw new Error('Unverified URL replacement');
          return replacement;
        });
        const fingerprint = group.table_name === 'note_versions' && group.column_name === 'writing'
          ? writingFingerprint(JSON.parse(after)) : null;
        const update = await db.query(`UPDATE ${table} SET ${field} = $1${json ? `::${group.data_type}` : ''}
          ${fingerprint ? ', fingerprint = $4' : ''}
          WHERE id = $2 AND ${field}${json ? '::jsonb' : ''} = $3${json ? '::jsonb' : ''}`,
        fingerprint ? [after, row.id, before, fingerprint] : [after, row.id, before]);
        if (update.rowCount !== 1) throw new Error('Data changed concurrently; transaction rolled back. Retry.');
      }
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify({ rewrittenUrls: replacements.size, sourceDeleted: false, cmsChanged: false }));
}

async function updateSearch(db) {
  if (!process.env.FOUNDRY_IQ_SEARCH_ENDPOINT || !process.env.FOUNDRY_IQ_SEARCH_ADMIN_KEY) {
    throw new Error('Search configuration required to update Athena search citations');
  }
  const { rows } = await db.query(`SELECT id, url FROM content_items WHERE source = 'user-upload' AND url LIKE $1`,
    [`https://${DESTINATION}.blob.core.windows.net/kb-documents/%`]);
  if (rows.length === 0) return;
  const response = await fetch(`${process.env.FOUNDRY_IQ_SEARCH_ENDPOINT}/indexes/kh-content-items/docs/index?api-version=2024-07-01`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': process.env.FOUNDRY_IQ_SEARCH_ADMIN_KEY },
    body: JSON.stringify({ value: rows.map(row => ({ '@search.action': 'merge', ...row })) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Search citation migration failed: HTTP ${response.status}`);
  const result = await response.json();
  if (result.value?.length !== rows.length || result.value.some(item => item.status !== true)) {
    throw new Error('Search citation migration returned unsuccessful item results');
  }
  console.log(JSON.stringify({ searchCitationsUpdated: rows.length }));
}

async function main() {
  const mode = process.argv[2];
  if (!['inventory', 'copy', 'rewrite', 'verify', 'search'].includes(mode)) throw new Error('Specify inventory, copy, rewrite, verify or search');
  if (process.env.SOURCE_ATHENA_STORAGE_ACCOUNT !== SOURCE || process.env.DESTINATION_ATHENA_STORAGE_ACCOUNT !== DESTINATION) {
    throw new Error('Migration is restricted to the reviewed source and destination');
  }
  const fromKey = process.env.SOURCE_ATHENA_STORAGE_KEY;
  const toKey = process.env.DESTINATION_ATHENA_STORAGE_KEY;
  if (!fromKey || !toKey || !process.env.DATABASE_URL) throw new Error('Explicit credentials required');
  const source = new BlobServiceClient(`https://${SOURCE}.blob.core.windows.net`, new StorageSharedKeyCredential(SOURCE, fromKey));
  const destination = new BlobServiceClient(`https://${DESTINATION}.blob.core.windows.net`, new StorageSharedKeyCredential(DESTINATION, toKey));
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000 });
  await db.connect();
  try {
    if (mode === 'inventory') await references(db);
    else if (mode === 'copy') await copyAndVerify(source, destination, true);
    else if (mode === 'search') await updateSearch(db);
    else {
      const manifest = await copyAndVerify(source, destination, false);
      if (mode === 'rewrite') {
        await rewriteReferences(db, destination, manifest);
        await updateSearch(db);
      } else {
        const remaining = await references(db);
        if (remaining.length > 0) throw new Error('Old Athena storage references remain');
        console.log(JSON.stringify({ oldAthenaReferences: 0, cmsChanged: false }));
      }
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Athena storage migration failed:', String(error.message).replace(/https:\/\/[^\s"'<>]+/g, '[URL redacted]'));
    process.exitCode = 1;
  });
}
