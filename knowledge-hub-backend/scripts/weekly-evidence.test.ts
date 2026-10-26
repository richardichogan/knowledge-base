import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { DigestArticle } from '../src/ai/weeklyMicrosoftDigest.js';
process.env.DATABASE_URL = 'postgresql://isolated.invalid/weekly-evidence';
const { prepareWeeklyEvidence } = await import('../src/ai/weeklyEvidence.js');

const source: DigestArticle = { id: 'azure', title: 'Azure update', url: 'https://azure.microsoft.com/news',
  summary: 'Search snippet.', source: 'Web search', group: 'Microsoft', publishedAt: '2026-10-23T12:00:00Z', score: null, shelved: false };
test('selection excludes undated/unrelated sources and facts validation follows actual reading', async () => {
  const pg = new PGlite();
  const db = { query: (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
  const calls: string[] = [];
  try {
    const result = await prepareWeeklyEvidence(db, [source, { ...source, id: 'undated', publishedAt: '' },
      { ...source, id: 'other', title: 'Unrelated update', url: 'https://other.invalid' }], {
      select: async articles => { calls.push('select'); assert.deepEqual(articles.map(article => article.id), ['azure']);
        return JSON.stringify({ items: [{ id: 'azure', reason: 'Material release.' }] }); },
      read: async () => { calls.push('read'); return { title: source.title, text: 'Verified primary source. '.repeat(20) }; },
      validate: async articles => { calls.push('validate'); assert.ok(articles[0]?.body?.includes('Verified primary source.'));
        return JSON.stringify({ items: [{ id: 'azure', verified: true, claims: ['The release is in preview.'], reason: 'Explicitly supported.' }] }); },
    });
    assert.deepEqual(calls, ['select', 'read', 'validate']);
    assert.deepEqual(result.sources[0]?.verifiedClaims, ['The release is in preview.']);
    assert.equal(result.gaps.length, 0);
  } finally { await pg.close(); }
});
