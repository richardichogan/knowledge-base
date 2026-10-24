import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { modelReadingSteps, parseReadingStep, readWholeDocument, recallDocumentMemory, type ReadingOptions } from '../src/ai/knowledge/documentReading.js';
import type { KnowledgeAccess } from '../src/types/knowledge.js';
import { createLedger, ledgerCounts } from '../src/ai/knowledge/evidence.js';
import { recordToolEvidence } from '../src/ai/contextUsage.js';

const sessionId = '11111111-1111-4111-8111-111111111111';

test('invalid checkpoint quotations retry the same page once; provider failures are not silently retried', async () => {
  const inputs: Array<{ sourcePage: string; priorMemory: string; checkpointCorrection?: string }> = [];
  const steps = modelReadingSteps({
    chatBulk: async messages => {
      const input = JSON.parse(messages[1]!.content);
      inputs.push(input);
      return JSON.stringify({ summary: 'Current page summary', memory: 'Updated memory',
        excerpts: inputs.length === 1 ? ['fact from an earlier page'] : ['Current page fact'] });
    },
  });
  const result = await steps.summarise('Current page fact', 'fact from an earlier page', 'Review');
  assert.deepEqual(result.excerpts, ['Current page fact']);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.sourcePage, inputs[1]?.sourcePage);
  assert.equal(inputs[0]?.priorMemory, inputs[1]?.priorMemory);
  assert.match(inputs[1]?.checkpointCorrection ?? '', /sourcePage only/);
  let failedCalls = 0;
  const failing = modelReadingSteps({ chatBulk: async () => { failedCalls++; throw new Error('Provider rejected source'); } });
  await assert.rejects(failing.summarise('Source', '', 'Review'), /Provider rejected source/);
  assert.equal(failedCalls, 1);
});
async function fixture() {
  const pg = new PGlite();
  await pg.exec('CREATE TABLE ai_chat_sessions(id uuid PRIMARY KEY)');
  await pg.query('INSERT INTO ai_chat_sessions VALUES ($1)', [sessionId]);
  await pg.exec(await readFile(new URL('../src/db/migrations/097_document_reading_memory.sql', import.meta.url), 'utf8'));
  return pg;
}
function options(text: string, overrides: Partial<ReadingOptions> = {}): ReadingOptions {
  return {
    sessionId, scopeKey: 'any', purpose: 'Review every requirement and newsletter entry',
    read: async (cursor?: string): Promise<KnowledgeAccess> => {
      const start = Number(cursor ?? 0);
      const end = Math.min(start + 12_000, text.length);
      const nextCursor = end < text.length ? String(end) : null;
      return { status: nextCursor === null ? 'ok' : 'partial', coverage: { totalChars: text.length, returnedChars: end - start, complete: start === 0 && nextCursor === null }, issues: [],
        record: { ref: { kind: 'note', id: 'newsletter' }, title: 'A very long newsletter', projectId: null,
          fields: {}, origin: 'human', version: 'v1', createdAt: null, updatedAt: null, locator: {},
          extractionState: 'complete', content: text.slice(start, end), startOffset: start, endOffset: end, totalChars: text.length, nextCursor, untrusted: true } };
    },
    summarise: async (source, memory) => ({ summary: `${source.slice(0, 40)} ${source.slice(-80)}`,
      memory: `${memory.slice(-1_000)} ${source.slice(-80)}`, excerpts: [source.slice(-60)] }),
    reduce: async summaries => summaries.join('\n').slice(-5_000),
    ...overrides,
  };
}

test('full-document reader processes beyond old character, page and tool limits with bounded model inputs', async () => {
  const pg = await fixture();
  try {
    const source = `FIRST REQUIREMENT\n${'Structured data.\n'.repeat(100_000)}FINAL-ACCEPTANCE-973`;
    let processed = 0;
    let maximumContext = 0;
    const base = options(source);
    const result = await readWholeDocument(pg as unknown as Pool, options(source, {
      summarise: async (page, memory, purpose) => {
        maximumContext = Math.max(maximumContext, page.length + memory.length);
        processed += page.length;
        return base.summarise(page, memory, purpose);
      },
      reduce: async (summaries, purpose) => {
        assert.ok(summaries.join('').length <= 18_000);
        return base.reduce(summaries, purpose);
      },
    }));
    assert.ok('review' in result);
    assert.equal(result.review.complete, true);
    assert.equal(result.review.readChars, source.length);
    assert.equal(processed, source.length);
    assert.ok(result.review.pagesRead > 100);
    assert.ok(maximumContext < 24_000);
    assert.match(result.review.summary, /FINAL-ACCEPTANCE-973/);
    const chunks = await pg.query<{ n: number; chars: number }>('SELECT COUNT(*)::int AS n,SUM(end_offset-start_offset)::int AS chars FROM document_reading_chunks');
    assert.equal(chunks.rows[0]?.chars, source.length);
    assert.equal(chunks.rows[0]?.n, result.review.pagesRead);
    const ledger = createLedger();
    recordToolEvidence(ledger, 'read_knowledge_record', result, { kind: 'note', id: 'newsletter' });
    assert.equal(ledgerCounts(ledger).read, 1);
    assert.ok(ledger.entries.get('note:newsletter')?.fields.includes('full_stored_document_processed'));
    assert.ok(!ledger.texts.get('note:newsletter')?.includes(result.review.summary));
    const firstPage = await base.read();
    assert.ok('record' in firstPage);
    const recalled = await recallDocumentMemory(pg as unknown as Pool, sessionId, result.review.id, firstPage.record, 0) as {
      derived: boolean; chunks: unknown[]; nextOffset: number;
    };
    assert.equal(recalled.derived, true);
    assert.equal(recalled.chunks.length, 3);
    assert.equal(recalled.nextOffset, 36_000);
    await assert.rejects(recallDocumentMemory(pg as unknown as Pool, '22222222-2222-4222-8222-222222222222', result.review.id, firstPage.record, 0), /unavailable/);
  } finally { await pg.close(); }
});

test('interrupted reading resumes from the committed page, not from the beginning', async () => {
  const pg = await fixture();
  try {
    const source = `${'x'.repeat(100_000)}TAIL-ONLY-FACT`;
    const base = options(source);
    let calls = 0;
    await assert.rejects(readWholeDocument(pg as unknown as Pool, options(source, {
      summarise: async (...args) => {
        calls++;
        if (calls === 4) throw new Error('Provider unavailable');
        return base.summarise(...args);
      },
    })), /Provider unavailable/);
    const saved = await pg.query<{ next_offset: number; memory: string; lease_owner: string | null }>('SELECT next_offset,memory,lease_owner FROM document_reading_sessions');
    assert.equal(saved.rows[0]?.next_offset, 36_000);
    assert.ok(saved.rows[0]?.memory);
    assert.equal(saved.rows[0]?.lease_owner, null);
    const starts: number[] = [];
    const resumed = await readWholeDocument(pg as unknown as Pool, options(source, {
      resume: true, purpose: 'continue',
      read: async cursor => { starts.push(Number(cursor ?? 0)); return base.read(cursor); },
      summarise: async (page, memory, purpose) => {
        assert.equal(purpose, base.purpose);
        return base.summarise(page, memory, purpose);
      },
    }));
    assert.ok('review' in resumed);
    assert.equal(resumed.review.complete, true);
    assert.equal(starts[1], 36_000);
    assert.match(resumed.review.summary, /TAIL-ONLY-FACT/);
  } finally { await pg.close(); }
});

test('excluded/deleted sources and changed versions never reuse stale reading memory', async () => {
  const pg = await fixture();
  try {
    const base = options('FIRST VERSION');
    await readWholeDocument(pg as unknown as Pool, base);
    const denied = await readWholeDocument(pg as unknown as Pool, options('', { read: async () => ({ status: 'excluded' }) }));
    assert.deepEqual(denied, { status: 'excluded' });
    let processed = '';
    const updated = options('NEW VERSION');
    const result = await readWholeDocument(pg as unknown as Pool, options('NEW VERSION', {
      read: async cursor => {
        const page = await updated.read(cursor);
        if ('record' in page) page.record.version = 'v2';
        return page;
      },
      summarise: async (text, memory, purpose) => {
        assert.equal(memory, '');
        processed += text;
        return updated.summarise(text, memory, purpose);
      },
    }));
    assert.equal(processed, 'NEW VERSION');
    assert.ok('review' in result);
    assert.equal(result.review.version, 'v2');
    assert.doesNotMatch(result.review.summary, /FIRST VERSION/);
  } finally { await pg.close(); }
});

test('cancellation preserves the last committed checkpoint and rejects fabricated model quotations', async () => {
  const pg = await fixture();
  try {
    const controller = new AbortController();
    const base = options('x'.repeat(30_000));
    let pages = 0;
    await assert.rejects(readWholeDocument(pg as unknown as Pool, options('x'.repeat(30_000), {
      signal: controller.signal,
      summarise: async (...args) => {
        pages++;
        if (pages === 2) controller.abort(new Error('Stopped'));
        return base.summarise(...args);
      },
    })), /Stopped/);
    const row = await pg.query<{ next_offset: number }>('SELECT next_offset FROM document_reading_sessions');
    assert.equal(row.rows[0]?.next_offset, 12_000);
    assert.throws(() => parseReadingStep(JSON.stringify({ summary: 'ok', memory: 'ok', excerpts: ['invented'] }), 'actual source'), /unverified quotation/);
  } finally { await pg.close(); }
});
