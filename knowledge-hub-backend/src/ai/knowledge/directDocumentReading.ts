import type { KnowledgeAccess, KnowledgeIssue } from '../../types/knowledge.js';
import { textTokens } from './reviewContext.js';

type Read = (cursor?: string) => Promise<KnowledgeAccess>;
interface DirectReadOptions {
  read: Read;
  availableTokens: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((text: string) => void) | undefined;
}
export interface DirectReadResult { result: KnowledgeAccess; pagesRead: number }

/** Null means the complete original needs the bounded, checkpointed overflow path. */
export async function readDirectDocument(options: DirectReadOptions): Promise<DirectReadResult | null> {
  if (options.availableTokens <= 0) return null;
  options.signal?.throwIfAborted();
  let page = await options.read();
  if (!('record' in page)) return { result: page, pagesRead: 0 };
  const first = page.record;
  let offset = 0;
  let pagesRead = 0;
  let tokens = 0;
  const content: string[] = [];
  const issues = new Map<string, KnowledgeIssue>();
  for (;;) {
    options.signal?.throwIfAborted();
    const record = page.record;
    if (record.ref.kind !== first.ref.kind || record.ref.id !== first.ref.id
      || record.version !== first.version || record.totalChars !== first.totalChars
      || record.startOffset !== offset || record.content.length !== record.endOffset - offset
      || record.endOffset <= offset && record.totalChars !== 0
      || page.issues.some(issue => issue.code === 'version_changed')) {
      throw new Error('The source changed or returned a non-contiguous page. No complete review was admitted.');
    }
    tokens += textTokens(record.content);
    if (tokens > options.availableTokens) return null;
    content.push(record.content);
    for (const issue of page.issues) issues.set(`${issue.code}:${issue.message}`, issue);
    pagesRead++;
    offset = record.endOffset;
    options.onProgress?.(`Loading ${first.title}: ${offset.toLocaleString()} of ${first.totalChars.toLocaleString()} characters`);
    if (record.nextCursor === null) break;
    const next = await options.read(record.nextCursor);
    if (!('record' in next)) return { result: next, pagesRead };
    page = next;
  }
  if (offset !== first.totalChars) throw new Error('The source ended before all stored content was returned.');
  options.signal?.throwIfAborted();
  const current = await options.read();
  if (!('record' in current)) return { result: current, pagesRead };
  if (current.record.version !== first.version || current.record.ref.kind !== first.ref.kind
    || current.record.ref.id !== first.ref.id || current.record.totalChars !== first.totalChars) {
    throw new Error('The source changed before its full text could be reviewed.');
  }
  const result: KnowledgeAccess = {
    status: first.extractionState === 'complete' && issues.size === 0 ? 'ok' : 'partial',
    record: { ...first, content: content.join(''), startOffset: 0, endOffset: offset, nextCursor: null },
    coverage: { totalChars: offset, returnedChars: offset, complete: true },
    issues: [...issues.values()],
  };
  return textTokens(JSON.stringify(result)) <= options.availableTokens ? { result, pagesRead } : null;
}
