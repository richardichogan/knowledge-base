/**
 * icaCollectionSync.ts
 *
 * Syncs IBM-internal ICA document collections (strategy decks, capability
 * mappings, architecture diagrams — content that lives outside the
 * Alliance-tenant M365 integration) into content_items, so it's searchable
 * via search_knowledge_base/FoundryIQ alongside everything else.
 *
 * ICA already extracts plain text from each file server-side (PPTX slides,
 * XLSX sheets, etc. are pre-parsed) — GET /document-collections/{id} lists a
 * collection's files, GET /files/{id} returns each file's extracted content.
 * Both calls require the separate ICA "consulting"/developer key, not the
 * coding-agent key used for chat.
 *
 * Static config below (collection ID -> KH project) mirrors the MAILBOXES
 * pattern in graphMailSync.ts — add a new entry here when another ICA
 * collection needs to be synced.
 */

import type { Pool } from 'pg';
import { isIcaConsultingEnabled, listCollectionFiles, getFileContent } from '../../ai/icaClient.js';
import { upsertContentItem, upsertSyncState } from '../../db/queries.js';
import type { ContentItem } from '../../types/contentItem.js';

const SYNC_SOURCE = 'ica-document';
const SYNC_STATE_KEY = 'ica-collections';
const MAX_BODY_CHARS = 20_000; // these files (decks/sheets) are far larger than typical content_items rows
const MAX_SUMMARY_CHARS = 300;

interface CollectionConfig {
  collectionId: string;
  label: string;
  projectContext: string;
}

const COLLECTIONS: CollectionConfig[] = [
  {
    collectionId: '7191f616-dffd-42eb-b2f1-c3eba4291c9e',
    label: 'Project Imagine',
    projectContext: 'imagine',
  },
];

/** Syncs all configured ICA document collections into content_items. */
export async function syncIcaCollections(
  db: Pool,
): Promise<{ indexed: number; errors: number }> {
  if (!isIcaConsultingEnabled()) {
    return { indexed: 0, errors: 0 };
  }

  let indexed = 0;
  let errors = 0;

  for (const collection of COLLECTIONS) {
    try {
      const files = await listCollectionFiles(collection.collectionId);
      console.warn(`[ICA] ${collection.label}: ${String(files.length)} files in collection`);

      for (const file of files) {
        try {
          const extracted = await getFileContent(file.id);
          if (extracted.status !== 'completed' || !extracted.content) {
            console.warn(`[ICA] Skipping ${file.name} — extraction status: ${extracted.status}`);
            continue;
          }

          await upsertContentItem(db, fileToContentItem(file, extracted, collection));
          indexed++;
        } catch (err) {
          errors++;
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ICA] Upsert failed for file ${file.id} (${file.name}): ${message}`);
        }
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ICA] Failed to list collection ${collection.label}: ${message}`);
    }
  }

  await upsertSyncState(db, SYNC_STATE_KEY, {
    lastSyncAt: new Date(),
    lastError: errors > 0 ? `${errors} errors` : null,
    itemCount: indexed,
  });

  return { indexed, errors };
}

function fileToContentItem(
  file: { id: string; name: string; contentType: string; updatedAt: number },
  extracted: { content: string },
  collection: CollectionConfig,
): Omit<ContentItem, 'id' | 'indexedAt'> {
  const body = extracted.content.slice(0, MAX_BODY_CHARS);
  const summary = `${collection.label} — ${file.name}: ${body.slice(0, MAX_SUMMARY_CHARS)}`;
  const publishedAt = file.updatedAt
    ? new Date(file.updatedAt * 1000).toISOString()
    : new Date().toISOString();

  return {
    source: SYNC_SOURCE,
    sourceId: `ica-file-${file.id}`,
    title: `[${collection.label}] ${file.name}`,
    summary,
    body,
    publishedAt,
    projectContext: collection.projectContext,
    metadata: {
      icaFileId: file.id,
      icaCollectionId: collection.collectionId,
      collectionLabel: collection.label,
      contentType: file.contentType,
    },
    tags: ['ica', collection.projectContext],
  };
}
