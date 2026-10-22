/**
 * Default handlers for the durable indexing queue: the legacy whole-document
 * index plus the additive passage index. Errors are mapped to safe codes.
 */
import type { Pool } from 'pg';
import {
  canIndexToFoundryIq, deleteIndexedContentItems, deleteItemPassages, indexContentItem, indexItemPassages, isPassageIndexAvailable,
  PASSAGE_INDEXED_SOURCES,
} from '../../ai/foundryIqIndexer.js';
import { getContentItemsByIds, markContentItemFoundryIndexed } from '../../db/queries.js';
import {
  clearPassages, IndexingFailure, loadPassageHashes, recordPassages, runIndexingBatch, enqueueContentItemIndex,
  enqueueContentItemDelete, reconcileIndexingBacklog, type BatchResult, type IndexingHandlers, type WorkQueryable,
} from './indexingWork.js';
import { assertBulkIndexingEnabled, isBulkIndexingEnabled } from './indexingSwitch.js';

function toFailure(err: unknown): IndexingFailure {
  if (err instanceof IndexingFailure) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new IndexingFailure('timeout');
  return new IndexingFailure('index_item_failed');
}

export function createDefaultIndexingHandlers(db: Pool): IndexingHandlers {
  return {
    async index(refId): Promise<void> {
      if (!canIndexToFoundryIq()) throw new IndexingFailure('semantic_unavailable');
      const [item] = await getContentItemsByIds(db, [refId]);
      if (item === undefined) return;
      try {
        await indexContentItem(item);
        if (PASSAGE_INDEXED_SOURCES.has(item.source) && await isPassageIndexAvailable()) {
          const outcome = await indexItemPassages(item, await loadPassageHashes(db, item.id));
          await recordPassages(db, item.id, outcome.indexed, outcome.staleOrdinals);
        }
        await markContentItemFoundryIndexed(db, item.id);
      } catch (err) {
        throw toFailure(err);
      }
    },
    async remove(refId): Promise<void> {
      if (!canIndexToFoundryIq()) throw new IndexingFailure('semantic_unavailable');
      try {
        const ordinals = [...(await loadPassageHashes(db, refId)).keys()];
        await deleteIndexedContentItems([refId]);
        if (ordinals.length > 0 && await isPassageIndexAvailable()) await deleteItemPassages(refId, ordinals);
        await clearPassages(db, refId);
      } catch (err) {
        throw toFailure(err);
      }
    },
  };
}

const DEFAULT_DRAIN_BATCHES = 3;

async function drainUnchecked(db: Pool, maxBatches: number): Promise<BatchResult | null> {
  let last: BatchResult | null = null;
  try {
    const handlers = createDefaultIndexingHandlers(db);
    let afterId = 0;
    for (let i = 0; i < maxBatches; i++) {
      last = await runIndexingBatch(db as unknown as WorkQueryable, handlers, { afterId });
      if (last.claimed === 0) break;
      afterId = last.lastId;
    }
  } catch (err) {
    console.error('[IndexingWork] drain failed:', err instanceof Error ? err.message : String(err));
  }
  return last;
}

/** Bulk path: drains at most `maxBatches` keyset batches only while the admin switch is ON; never throws. */
export async function drainIndexingWork(db: Pool, maxBatches: number = DEFAULT_DRAIN_BATCHES): Promise<BatchResult | null> {
  if (!(await isBulkIndexingEnabled(db))) {
    console.warn('[IndexingWork] Bulk indexing is switched off - skipping bulk drain.');
    return null;
  }
  return drainUnchecked(db, maxBatches);
}

/** Bulk reconcile (enqueues one page of the backlog); throws BulkIndexingDisabledError while the switch is OFF. */
export async function bulkReconcileIndexingBacklog(
  db: Pool, options: { afterId?: string; limit?: number; now?: Date } = {},
): ReturnType<typeof reconcileIndexingBacklog> {
  await assertBulkIndexingEnabled(db);
  return reconcileIndexingBacklog(db as unknown as WorkQueryable, options);
}

/**
 * Best-effort kick after a write: the durable row already exists, so a
 * semantic outage here only delays indexing. Per-write indexing is never
 * gated by the bulk switch.
 */
export function kickIndexingWork(db: Pool): void {
  void drainUnchecked(db, 1);
}

export { enqueueContentItemIndex, enqueueContentItemDelete };
