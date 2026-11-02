import type { Pool } from 'pg';
import { fetchPageDescription, toPlainSummary } from '../integrations/discovery/feedReader.js';
import { NotFoundError } from '../types/errors.js';

const RETRY_AFTER_MS = 86_400_000;
const pending = new Map<string, Promise<PublisherSummary>>();
const waiting: Array<() => void> = [];
const MAX_CONCURRENT_READS = 4;
let activeReads = 0;

async function readSeoSummary(url: string): Promise<string> {
  if (activeReads >= MAX_CONCURRENT_READS) await new Promise<void>(resolve => { waiting.push(resolve); });
  else activeReads++;
  try { return await fetchPageDescription(url, true); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else activeReads--;
  }
}

export interface PublisherSummary {
  text: string | null;
  origin: 'feed' | 'seo';
}

export function storedPublisherSummary(body: string | null, metadata: Record<string, unknown>): PublisherSummary {
  const origin = metadata['publisherSummaryOrigin'] === 'seo' ? 'seo' : 'feed';
  if (metadata['contentKind'] === 'youtube-video' || metadata['contentBasis']) return { text: null, origin };
  const summary = typeof metadata['publisherSummary'] === 'string' ? metadata['publisherSummary'] : body ?? '';
  return { text: toPlainSummary(summary) || null, origin };
}

export async function getPublisherSummary(db: Pool, id: string): Promise<PublisherSummary> {
  const active = pending.get(id);
  if (active) return active;
  const work = loadPublisherSummary(db, id);
  pending.set(id, work);
  try { return await work; }
  finally { pending.delete(id); }
}

async function loadPublisherSummary(db: Pool, id: string): Promise<PublisherSummary> {
  const row = (await db.query<{ body: string | null; url: string | null; metadata: Record<string, unknown> }>(
    "SELECT body,url,metadata FROM content_items WHERE id::text=$1 AND source='discovered-article'", [id],
  )).rows[0];
  if (!row) throw new NotFoundError('Discover article');
  const saved = storedPublisherSummary(row.body, row.metadata);
  if (saved.text || !row.url || row.metadata['contentKind'] === 'youtube-video' || row.metadata['contentBasis']) return saved;
  const checkedAt = typeof row.metadata['publisherSummaryCheckedAt'] === 'string'
    ? Date.parse(row.metadata['publisherSummaryCheckedAt']) : NaN;
  if (Date.now() - checkedAt < RETRY_AFTER_MS) {
    if (row.metadata['publisherSummaryStatus'] === 'failed') throw new Error('Publisher summary retrieval failed; the page will be checked again after the cache expires.');
    return saved;
  }
  let text: string;
  try { text = await readSeoSummary(row.url); }
  catch (error) {
    await db.query(`UPDATE content_items SET metadata=metadata || jsonb_build_object(
      'publisherSummaryCheckedAt',$2::text,'publisherSummaryStatus','failed') WHERE id::text=$1 AND source='discovered-article'`,
    [id, new Date().toISOString()]);
    throw error;
  }
  const updated = (await db.query<{ body: string; metadata: Record<string, unknown> }>(`
    UPDATE content_items SET
      body=CASE WHEN COALESCE(body,'')=$4 AND $2<>'' THEN $2 ELSE body END,
      metadata=metadata || jsonb_build_object('publisherSummaryCheckedAt',$3::text,'publisherSummaryStatus',CASE WHEN $2<>'' THEN 'ready' ELSE 'unavailable' END)
        || CASE WHEN COALESCE(body,'')=$4 AND $2<>'' THEN jsonb_build_object('publisherSummaryOrigin','seo','publisherSummary',$2::text) ELSE '{}'::jsonb END
    WHERE id::text=$1 AND source='discovered-article' RETURNING body,metadata`,
  [id, text, new Date().toISOString(), row.body ?? ''])).rows[0];
  if (!updated) throw new NotFoundError('Discover article');
  return storedPublisherSummary(updated.body, updated.metadata);
}
