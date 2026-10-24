import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { getDb, closeDb } from '../src/db/db.js';
import { FoundryClient } from '../src/ai/foundryClient.js';
import { modelReadingSteps, readWholeDocument } from '../src/ai/knowledge/documentReading.js';
import type { KnowledgeAccess } from '../src/types/knowledge.js';

if (process.env['DOCUMENT_READING_EVAL_LIVE'] !== 'approved') {
  throw new Error('Live reading evaluation requires DOCUMENT_READING_EVAL_LIVE=approved. Uses synthetic source data only.');
}
const sessionId = '77777777-7777-4777-8777-777777777777';
const facts = [
  'REQ-START: The controller must approve any payment above GBP 73000.',
  'STORY-MIDDLE: An analyst may prepare a payment but may not approve their own payment.',
  'FIXTURE-42: Opening balance GBP 125000; debit GBP 19000; closing balance GBP 106000.',
  'NEWSLETTER-LEAD: Audience is finance directors, not developers; tone is practical, not promotional.',
  'CONFLICT-19: Retain both a 30-day and a 90-day retention requirement as an unresolved conflict.',
  'AC-FINAL-99: Rejection must leave the ledger unchanged and record the rejection reason.',
];
const pages = facts.map(fact => `${fact}\n${'Background material with no additional requirements. '.repeat(240)}`);
const source = pages.join('\n');
const pg = new PGlite();
// Prevent model-usage telemetry from writing to the configured production DB during this eval.
const telemetry = mock.method(getDb(), 'query', async () => ({ rows: [] }));
const startedAt = new Date().toISOString();
let processedChars = 0;
try {
  await pg.exec('CREATE TABLE ai_chat_sessions(id uuid PRIMARY KEY)');
  await pg.query('INSERT INTO ai_chat_sessions VALUES ($1)', [sessionId]);
  await pg.exec(await readFile(new URL('../src/db/migrations/097_document_reading_memory.sql', import.meta.url), 'utf8'));
  const client = new FoundryClient('document-reading-eval');
  const model = modelReadingSteps(client);
  const result = await readWholeDocument(pg as unknown as Pool, {
    sessionId, scopeKey: 'synthetic-evaluation', purpose: 'Review this specification/newsletter source in full. Preserve all six labelled requirements/acceptance facts, exact financial figures, audience, and the unresolved retention conflict.',
    read: async cursor => {
      const start = Number(cursor ?? 0);
      const end = Math.min(start + 12_000, source.length);
      const nextCursor = end < source.length ? String(end) : null;
      return { status: nextCursor === null ? 'ok' : 'partial', issues: [],
        coverage: { totalChars: source.length, returnedChars: end - start, complete: start === 0 && nextCursor === null },
        record: { ref: { kind: 'note', id: 'synthetic-spec-newsletter' }, title: 'Synthetic full-source review',
          content: source.slice(start, end), startOffset: start, endOffset: end, totalChars: source.length,
          nextCursor, version: 'v1', origin: 'human', fields: {}, projectId: null, createdAt: null, updatedAt: null,
          locator: {}, extractionState: 'complete', untrusted: true } } satisfies KnowledgeAccess;
    },
    ...model,
    summarise: async (text, memory, purpose) => {
      const step = await model.summarise(text, memory, purpose);
      processedChars += text.length;
      return step;
    },
    onProgress: text => { console.log(text); },
  });
  assert.ok('review' in result);
  const summary = result.review.summary;
  const checks = {
    fullStoredCoverage: result.review.complete && result.review.readChars === source.length && processedChars === source.length,
    beginning: /73000|73,000/.test(summary) && /controller/i.test(summary),
    middle: /analyst/i.test(summary) && /own|self/i.test(summary),
    arithmeticFixture: /125,?000/.test(summary) && /19,?000/.test(summary) && /106,?000/.test(summary),
    newsletterAudience: /finance directors/i.test(summary) && /practical/i.test(summary),
    unresolvedConflict: /\b30\b/.test(summary) && /\b90\b/.test(summary) && /conflict|unresolved/i.test(summary),
    endingAcceptance: /unchanged/i.test(summary) && /rejection reason/i.test(summary),
  };
  const report = { startedAt, syntheticOnly: true, productionWrites: false, sourceChars: source.length,
    pagesRead: result.review.pagesRead, checks, passed: Object.values(checks).every(Boolean), summary };
  console.log(JSON.stringify(report, null, 2));
  if (process.env['DOCUMENT_READING_EVAL_OUT']) await writeFile(process.env['DOCUMENT_READING_EVAL_OUT'], JSON.stringify(report, null, 2));
  assert.ok(report.passed, 'Live full-document reading evaluation failed; inspect the recorded source-position checks.');
} finally {
  telemetry.mock.restore(); await pg.close(); await closeDb();
}
