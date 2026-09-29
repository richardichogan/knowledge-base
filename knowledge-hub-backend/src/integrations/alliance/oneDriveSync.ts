/**
 * integrations/alliance/oneDriveSync.ts — syncs documents from the user's
 * OneDrive on the IBM Alliance tenant into content_items (source
 * 'onedrive-document'), replacing the ICA document collections.
 *
 * Layout: <ALLIANCE_ONEDRIVE_ROOT>/<Project>/…  (default root "Athena").
 * The first folder under the root maps to an Athena project by id or name
 * (e.g. Athena/IMAGINE → project "imagine"); files directly in the root, or
 * in an unmatched folder, go to "personal".
 *
 * Incremental: a file is only downloaded when its cTag (content version)
 * changes. Text comes from the shared document extractor; images — standalone
 * files and pictures inside PowerPoint decks — are described with the same
 * vision analysis Think uses, so diagrams stay searchable (ICA used to do
 * this server-side). Files removed from OneDrive are removed from Athena.
 */

import JSZip from 'jszip';
import type { Pool } from 'pg';
import { env } from '../../config/env.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import { extractDocumentText } from '../github/documentExtractor.js';
import { analyzeImageWithVision } from '../../services/visionAnalyzer.js';
import { allianceGraphGet, allianceDownload, getAllianceStatus, isAllianceConfigured } from './allianceGraph.js';
import type { ContentItem } from '../../types/contentItem.js';

const SOURCE = 'onedrive-document';
const SYNC_STATE_KEY = 'onedrive-documents';
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_BODY_CHARS = 250_000;
const MAX_SUMMARY_CHARS = 300;
// Pictures inside a deck: skip icons/logos, cap the number described per file.
const DECK_IMAGE_MIN_BYTES = 20_000;
const DECK_IMAGES_MAX = 12;

const TEXT_TYPES = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'md', 'markdown', 'txt']);
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  cTag?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount: number };
  file?: { mimeType?: string };
}

interface ChildrenPage {
  value: DriveItem[];
  '@odata.nextLink'?: string;
}

interface FoundFile {
  item: DriveItem;
  /** Path under the root, e.g. "IMAGINE/PRDs/Governance.docx". */
  relPath: string;
  /** First folder under the root, or '' for root-level files. */
  topFolder: string;
}

/** Lists every file under a folder, recursively (follows paging). */
async function listFiles(db: Pool, folderPath: string, relPrefix: string, topFolder: string, out: FoundFile[]): Promise<void> {
  const select = '$select=id,name,size,cTag,webUrl,lastModifiedDateTime,folder,file&$top=200';
  let next: string | undefined = `/me/drive/root:/${encodeURI(folderPath)}:/children?${select}`;
  while (next !== undefined) {
    const page: ChildrenPage = await allianceGraphGet<ChildrenPage>(db, next);
    for (const item of page.value) {
      const relPath = relPrefix === '' ? item.name : `${relPrefix}/${item.name}`;
      if (item.folder) {
        await listFiles(db, `${folderPath}/${item.name}`, relPath, topFolder === '' ? item.name : topFolder, out);
      } else if (item.file) {
        out.push({ item, relPath, topFolder });
      }
    }
    next = page['@odata.nextLink'];
  }
}

/** Maps a top-level folder name to a project id (by id or name, ignoring case/spaces). */
async function projectResolver(db: Pool): Promise<(folder: string) => string> {
  const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM projects`);
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byKey = new Map<string, string>();
  for (const r of rows) {
    byKey.set(norm(r.id), r.id);
    byKey.set(norm(r.name), r.id);
  }
  return (folder) => (folder === '' ? 'personal' : byKey.get(norm(folder)) ?? 'personal');
}

/** Describes the larger pictures inside a PowerPoint deck. */
async function describeDeckImages(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const media = Object.values(zip.files).filter((f) => /^ppt\/media\/.+\.(png|jpe?g|gif|webp)$/i.test(f.name));
  const described: string[] = [];
  for (const file of media) {
    if (described.length >= DECK_IMAGES_MAX) break;
    const data = await file.async('nodebuffer');
    if (data.length < DECK_IMAGE_MIN_BYTES) continue;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
    const text = await analyzeImageWithVision(data, IMAGE_TYPES[ext] ?? 'image/png');
    if (text.trim() !== '') described.push(`[Deck image ${(described.length + 1).toString()}] ${text.trim()}`);
  }
  return described;
}

/** Extracts searchable text (plus image descriptions) from one file. */
async function extractFileText(name: string, buffer: Buffer): Promise<{ text: string; warning?: string }> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const imageMime = IMAGE_TYPES[ext];
  if (imageMime !== undefined) {
    const description = await analyzeImageWithVision(buffer, imageMime);
    return { text: description.trim() !== '' ? `Image: ${name}\n\n${description.trim()}` : '' };
  }
  const result = await extractDocumentText(buffer, name);
  let text = result.text;
  if (ext === 'pptx') {
    try {
      const images = await describeDeckImages(buffer);
      if (images.length > 0) text = `${text}\n\nImages in this deck (described by vision analysis):\n${images.join('\n\n')}`;
    } catch (err) {
      return { text, warning: `deck images skipped: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return result.error !== undefined ? { text, warning: result.error } : { text };
}

/** Syncs OneDrive (Alliance) documents. No-op until the connection is set up. */
export async function syncOneDriveDocuments(db: Pool): Promise<{ indexed: number; errors: number }> {
  if (!isAllianceConfigured()) return { indexed: 0, errors: 0 };
  const status = await getAllianceStatus(db);
  if (!status.connected) {
    await upsertSyncState(db, SYNC_STATE_KEY, { lastError: status.lastError ?? 'OneDrive (Alliance) not connected' });
    return { indexed: 0, errors: 0 };
  }

  const root = env.ALLIANCE_ONEDRIVE_ROOT.replace(/^\/+|\/+$/g, '');
  const files: FoundFile[] = [];
  try {
    await listFiles(db, root, '', '', files);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertSyncState(db, SYNC_STATE_KEY, { lastError: `Listing ${root} failed: ${message}` });
    console.error(`[onedrive] Listing ${root} failed: ${message}`);
    return { indexed: 0, errors: 1 };
  }

  // Files whose text came out empty (e.g. an extraction failure) have no
  // cTag stored, so they're retried on every sync until they succeed.
  const { rows: existingRows } = await db.query<{ source_id: string; ctag: string | null }>(
    `SELECT source_id, CASE WHEN coalesce(length(body), 0) = 0 THEN NULL ELSE metadata->>'cTag' END AS ctag
       FROM content_items WHERE source = $1`,
    [SOURCE],
  );
  const existing = new Map(existingRows.map((r) => [r.source_id, r.ctag]));
  const resolveProject = await projectResolver(db);

  let indexed = 0;
  let errors = 0;
  const warnings: string[] = [];

  for (const { item, relPath, topFolder } of files) {
    const ext = item.name.toLowerCase().split('.').pop() ?? '';
    if (!TEXT_TYPES.has(ext) && IMAGE_TYPES[ext] === undefined) continue;
    if ((item.size ?? 0) > MAX_FILE_BYTES) { warnings.push(`${relPath}: too large, skipped`); continue; }
    const known = existing.get(item.id);
    if (known !== undefined && known !== null && known === (item.cTag ?? null)) continue; // unchanged and extracted OK

    try {
      const buffer = await allianceDownload(db, item.id);
      const { text, warning } = await extractFileText(item.name, buffer);
      if (warning !== undefined) warnings.push(`${relPath}: ${warning}`);
      const body = text.slice(0, MAX_BODY_CHARS);
      const title = item.name.replace(/\.[^.]+$/, '');
      const doc: Omit<ContentItem, 'id' | 'indexedAt'> = {
        source: SOURCE,
        sourceId: item.id,
        title,
        summary: body.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS),
        body,
        publishedAt: item.lastModifiedDateTime ?? new Date().toISOString(),
        url: item.webUrl ?? '',
        projectContext: resolveProject(topFolder),
        // No cTag when extraction produced nothing, so the next sync retries it.
        metadata: { driveItemId: item.id, path: relPath, filename: item.name, cTag: body.trim() === '' ? null : item.cTag ?? null, fileType: ext, size: item.size ?? 0 },
        tags: ['onedrive'],
      };
      await upsertContentItem(db, doc);
      indexed++;
    } catch (err) {
      errors++;
      console.error(`[onedrive] Failed to sync ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Remove documents deleted (or moved out of the root) in OneDrive. Only
  // after a complete listing, so a partial failure never deletes content.
  const seen = files.map((f) => f.item.id);
  const removed = await db.query(
    `DELETE FROM content_items WHERE source = $1 AND NOT (source_id = ANY($2::text[]))`,
    [SOURCE, seen],
  );

  await upsertSyncState(db, SYNC_STATE_KEY, {
    lastSyncAt: new Date(),
    itemCount: files.length,
    lastError: errors > 0 ? `${errors.toString()} file(s) failed` : (warnings.length > 0 ? warnings.slice(0, 5).join('; ') : null),
  });
  if ((removed.rowCount ?? 0) > 0) console.warn(`[onedrive] Removed ${String(removed.rowCount)} deleted document(s)`);
  return { indexed, errors };
}

/** Sync status for the UI: connection + last sync. */
export async function getOneDriveSyncStatus(db: Pool): Promise<{ lastSyncAt: string | null; fileCount: number; documentCount: number; lastError: string | null }> {
  const state = await db.query<{ last_sync_at: string | null; item_count: number; last_error: string | null }>(
    `SELECT last_sync_at, item_count, last_error FROM sync_state WHERE source = $1`,
    [SYNC_STATE_KEY],
  );
  const count = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM content_items WHERE source = $1`, [SOURCE]);
  const row = state.rows[0];
  return {
    lastSyncAt: row?.last_sync_at ?? null,
    fileCount: row?.item_count ?? 0,
    documentCount: Number(count.rows[0]?.n ?? '0'),
    lastError: row?.last_error ?? null,
  };
}
