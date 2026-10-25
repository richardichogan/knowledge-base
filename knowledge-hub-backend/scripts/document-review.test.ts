import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocumentRevision, proposeDocumentRevision } from '../src/ai/documentReview.js';

const proposal = (find: string, replacement = 'Updated passage'): string =>
  JSON.stringify({ find, replacement, summary: 'Clarify selected behaviour' });

test('review accepts a unique selected Markdown fragment, including formatting', () => {
  const result = parseDocumentRevision(proposal('**Approve** the draft.'), {
    document: '# Workflow\n\n**Approve** the draft.\n\nKeep the audit log.',
    selection: 'Approve the draft.', matchMode: 'markdown',
  });
  assert.equal(result.find, '**Approve** the draft.');
  assert.equal(result.replacement, 'Updated passage');
});

test('review rejects unrelated, ambiguous, malformed and oversized proposals', () => {
  const context = { document: 'One passage.\n\nOther passage.', selection: 'One passage.', matchMode: 'markdown' as const };
  assert.throws(() => parseDocumentRevision(proposal('Other passage.'), context), /outside the selection/);
  assert.throws(() => parseDocumentRevision(proposal('One passage.\n\nOther passage.'), context), /outside the selection/);
  assert.throws(() => parseDocumentRevision(proposal('Missing passage.'), context), /matched safely/);
  assert.throws(() => parseDocumentRevision(proposal('One passage.'), { ...context, document: 'One passage. One passage.' }), /matched safely/);
  assert.throws(() => parseDocumentRevision('not JSON', context), /invalid JSON/);
  assert.throws(() => parseDocumentRevision('null', context), /invalid proposal/);
  assert.throws(() => parseDocumentRevision(proposal('One passage.', 'x'.repeat(60_001)), context), /matched safely/);
  assert.throws(() => parseDocumentRevision(proposal('One passage.', 'x'.repeat(60_000)), context), /document limit/);
});

test('text matching preserves the exact selection and supports explicit deletion', () => {
  const context = { document: '# Note\n\nSelected text.', selection: 'Selected text.', matchMode: 'text' as const };
  assert.deepEqual(parseDocumentRevision(proposal('Selected text.', ''), context), {
    find: 'Selected text.', replacement: '', summary: 'Clarify selected behaviour',
  });
  assert.throws(() => parseDocumentRevision(proposal('Different text.'), context), /matched safely/);
  assert.throws(() => parseDocumentRevision(JSON.stringify({ find: '', replacement: '', summary: 'Which approval role should be used?' }), context), /Which approval role/);
});

test('invalid review input fails before any model call', async () => {
  await assert.rejects(proposeDocumentRevision({}), /document must contain/);
  await assert.rejects(proposeDocumentRevision({ document: 'x'.repeat(60_001) }), /document must contain/);
  await assert.rejects(proposeDocumentRevision({ document: 'source', selection: 'x'.repeat(8001) }), /selection must contain/);
  await assert.rejects(proposeDocumentRevision({ document: 'source', selection: 'source', instruction: ' ' }), /instruction must contain/);
  await assert.rejects(proposeDocumentRevision({ document: 'source', selection: 'source', instruction: 'Clarify', matchMode: 'fuzzy' }), /text or markdown/);
});
