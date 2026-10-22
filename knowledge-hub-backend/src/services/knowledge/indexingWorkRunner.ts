/**
 * Default handlers for the durable indexing queue: the legacy whole-document
 * index plus the additive passage index. Errors are mapped to safe codes.
 */
import type { Pool } from 'pg';
import {
  canIndexToFoundryIq, deleteIndexedContentItems, deleteItemPassages, indexContentItem, indexItemPassages, PASSAGE_INDEXED_SOURCES,
} from '../../ai/foundryIqIndexer.js';
import { getContentItemsByIds, markContentItemFoundryIndexed } from '../../db/queries.js';
import {
  clearPassages, IndexingFailure, loadPassageHashes, recordPassages, runIndexingBatch, enqueueContentItemIndex,
  enqueueContentItemDelete, type BatchResult, type IndexingHandlers, type WorkQueryable,
} from './indexingWork.js';

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
        if (PASSAGE_INDEXED_SOURCES.has(item.source)) {
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
        await deleteItemPassages(refId, ordinals);
        await clearPassages(db, refId);
      } catch (err) {
        throw toFailure(err);
      }
    },
  };
}

const DEFAULT_DRAIN_BATCHES = 3;

/** Drains at most `maxBatches` keyset batches; never throws. */
export async function drainIndexingWork(db: Pool, maxBatches: number = DEFAULT_DRAIN_BATCHES): Promise<BatchResult | null> {
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

/**
 * Best-effort kick after a write: the durable row already exists, so a
 * semantic outage here only delays indexing.
 */
export function kickIndexingWork(db: Pool): void {
  void drainIndexingWork(db, 1);
}

export { enqueueContentItemIndex, enqueueContentItemDelete };
