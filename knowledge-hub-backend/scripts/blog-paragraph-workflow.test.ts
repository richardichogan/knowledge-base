import test from 'node:test';
import assert from 'node:assert/strict';
import { paragraphReviewCoverage, recheckParagraphUnits, repairBlogDraft, sourceReferenceIssues } from '../src/ai/blogEditorial.js';
import type { BlogDraft } from '../src/ai/blogDraft.js';
import type { FoundryClient } from '../src/ai/foundryClient.js';

const original: BlogDraft = {
  title: 'The registry', excerpt: 'A preview.', summary: 'The registry is in preview.',
  content: '<p>First paragraph.</p><p>Second paragraph.</p>',
  keyTakeaways: [], categories: ['AI'], tags: [], postType: 'article', sourceUrl: null,
};
const evidence = JSON.stringify({ body: 'The registry is in preview.' });

test('review guidance preserves supported summaries and checks readability and voice', async () => {
  let paragraphChecked = false;
  let styleChecked = false;
  await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      const instructions = messages[0]!.content;
      if (schema?.name === 'blog_paragraph_review') {
        assert.match(instructions, /partial list or summary does not need every source detail/);
        assert.match(instructions, /grammatical, natural and at least as clear/);
        paragraphChecked = true;
        return JSON.stringify({ action: 'keep', after: '', findings: [] });
      }
      if (instructions.includes('Review style, length and coherence')) {
        assert.match(instructions, /whole article for natural voice/);
        assert.match(instructions, /wording introduced during paragraph review/);
        styleChecked = true;
      }
      return JSON.stringify({ findings: [] });
    },
  }, { checkpointParagraph: async () => {} });
  assert.equal(paragraphChecked, true);
  assert.equal(styleChecked, true);
});

test('the original source title and link are preserved across equivalent footer markup', () => {
  const withSource = { ...original, sourceUrl: 'https://example.test/source',
    content: '<p>Draft.</p><hr><p><em>Source: <a href="https://example.test/source">Source &amp; title</a></em></p>' };
  assert.deepEqual(sourceReferenceIssues(withSource, { ...withSource,
    content: '<p>Draft.</p><hr /><p><em>Source: <a href="https://example.test/source">Source &amp; title</a></em></p>' }), []);
  assert.match(sourceReferenceIssues(withSource, { ...withSource, content: '<p>Draft.</p>' }).join(' '), /source reference/);
  assert.match(sourceReferenceIssues(withSource, { ...withSource,
    content: withSource.content.replace('https://example.test/source', 'https://example.test/other') }).join(' '), /source reference/);
});

test('paragraph edits and their cursor are checkpointed together and resumed without repeating them', async () => {
  let saved: BlogDraft | undefined;
  const stages: Array<{ id: string }> = [];
  const first: Pick<FoundryClient, 'chat'> = {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      assert.equal(schema?.name, 'blog_paragraph_review');
      const request = JSON.parse(messages[1]!.content);
      if (request.passage === 'Second paragraph.') throw new Error('Interrupted');
      return JSON.stringify({ action: 'replace', after: 'Revised paragraph.',
        findings: [{ reason: 'Unclear sentence', claim: 'First paragraph.', sourceIds: [] }] });
    },
  };
  await assert.rejects(repairBlogDraft(original, evidence, async () => {}, first, {
    originalDraft: original,
    checkpointParagraph: async (draft, result) => {
      saved = draft;
      stages.push(result as { id: string });
    },
  }), /Interrupted/);
  assert.equal(saved?.content, '<p>Revised paragraph.</p><p>Second paragraph.</p>');
  assert.deepEqual(stages.map(stage => stage.id), ['u1']);
  const seen: string[] = [];
  const resumed = await repairBlogDraft(saved!, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_paragraph_review') {
        seen.push(JSON.parse(messages[1]!.content).passage);
        return JSON.stringify({ action: 'keep', after: '', findings: [] });
      }
      return JSON.stringify({ findings: [] });
    },
  }, {
    originalDraft: original, completedParagraphs: new Set(stages.map(stage => stage.id)),
    checkpointParagraph: async () => {},
  });
  assert.ok(!seen.includes('First paragraph.'));
  assert.ok(seen.includes('Second paragraph.'));
  assert.equal(resumed.draft.content, saved!.content);
});

test('invalid unit output is retried once, recorded unresolved, and later units are still reviewed', async () => {
  let attempts = 0;
  const stages: Array<{ id: string; status: string }> = [];
  const result = await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name !== 'blog_paragraph_review') return JSON.stringify({ findings: [] });
      const request = JSON.parse(messages[1]!.content);
      if (request.id === 'u1') { attempts++; return JSON.stringify({ action: 'replace', after: 12, findings: [] }); }
      return JSON.stringify({ action: 'keep', after: '', findings: [] });
    },
  }, { checkpointParagraph: async (_draft, stage) => { stages.push(stage as { id: string; status: string }); } });
  assert.equal(attempts, 2);
  assert.equal(stages[0]?.status, 'failed');
  assert.ok(stages.some(stage => stage.id === 'u2'));
  assert.equal(result.draft.content, original.content);
  assert.equal(result.verification.verified, false);
});

test('an unchanged replacement receives the existing bounded same-unit retry', async () => {
  let attempts = 0;
  const stages: Array<{ stage: string; result: unknown }> = [];
  const result = await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name !== 'blog_paragraph_review') return JSON.stringify({ findings: [] });
      const request = JSON.parse(messages[1]!.content);
      if (request.id !== 'u1') return JSON.stringify({ action: 'keep', after: '', findings: [] });
      attempts++;
      if (attempts === 2) assert.match(request.previousValidationError, /identical to the target/);
      return JSON.stringify({ action: 'replace', after: attempts === 1 ? request.passage : 'Clearer paragraph.',
        findings: [{ reason: 'Unclear sentence', claim: request.passage, sourceIds: [] }] });
    },
  }, {
    record: async (stage, value) => { stages.push({ stage, result: value }); },
    checkpointParagraph: async () => {},
  });
  assert.equal(attempts, 2);
  assert.equal(result.draft.content, '<p>Clearer paragraph.</p><p>Second paragraph.</p>');
  assert.ok(stages.some(stage => stage.stage === 'paragraphReviewError'));
  assert.equal(result.verification.verified, true);
});

test('a proposed edit cannot change a protected link', async () => {
  const candidate = { ...original, content: '<p>Read <a href="https://example.test">the source</a>.</p>' };
  const result = await repairBlogDraft(candidate, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_paragraph_review') {
        const request = JSON.parse(messages[1]!.content);
        return JSON.stringify(request.field === 'content'
          ? { action: 'replace', after: 'Read the source.',
            findings: [{ reason: 'Unclear link text', claim: 'Read', sourceIds: [] }] }
          : { action: 'keep', after: '', findings: [] });
      }
      return JSON.stringify({ findings: [] });
    },
  }, { checkpointParagraph: async () => {} });
  assert.equal(result.draft.content, candidate.content);
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /protected HTML/);
});

test('a heading receives its own kind, and context claims cannot be edited as the heading', async () => {
  const candidate = { ...original, content: '<h2>A heading</h2><p>Neighbouring claim.</p>' };
  let headingCalls = 0;
  const stages: Array<{ id: string; status: string }> = [];
  const result = await repairBlogDraft(candidate, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name !== 'blog_paragraph_review') return JSON.stringify({ findings: [] });
      const request = JSON.parse(messages[1]!.content);
      if (request.id === 'u1') {
        headingCalls++;
        assert.equal(request.kind, 'heading');
        assert.match(request.context.next, /Neighbouring claim/);
        return JSON.stringify({ action: 'replace', after: 'An invented paragraph.',
          findings: [{ reason: 'Unsupported', claim: 'Neighbouring claim.', sourceIds: [] }] });
      }
      return JSON.stringify({ action: 'keep', after: '', findings: [] });
    },
  }, { checkpointParagraph: async (_draft, stage) => { stages.push(stage as { id: string; status: string }); } });
  assert.equal(headingCalls, 2);
  assert.equal(stages[0]?.status, 'failed');
  assert.equal(result.draft.content, candidate.content);
  assert.equal(result.verification.verified, false);
});

test('duplicate passages are changed only at their identified unit', async () => {
  const candidate = { ...original, content: '<p>Same text.</p><p>Same text.</p>' };
  const result = await repairBlogDraft(candidate, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name !== 'blog_paragraph_review') return JSON.stringify({ findings: [] });
      const request = JSON.parse(messages[1]!.content);
      return JSON.stringify(request.id === 'u1'
        ? { action: 'replace', after: 'Clear text.', findings: [{ reason: 'Unclear', claim: 'Same text.', sourceIds: [] }] }
        : { action: 'keep', after: '', findings: [] });
    },
  }, { checkpointParagraph: async () => {} });
  assert.equal(result.draft.content, '<p>Clear text.</p><p>Same text.</p>');
});

test('read-only recheck covers missing units and is bound to the exact draft', async () => {
  const records = [
    { stage: 'paragraphReview', result: { id: 'u1', field: 'content', before: 'First paragraph.', issues: [] } },
    { stage: 'paragraphReviewError', result: { id: 'u2', field: 'content' } },
    { stage: 'paragraphReview', result: { id: 'u3', field: 'title', before: original.title, issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u4', field: 'excerpt', before: original.excerpt, issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u5', field: 'summary', before: original.summary, issues: [] } },
  ];
  assert.equal(paragraphReviewCoverage(original, records).length, 1);
  const seen: string[] = [];
  const checked = await recheckParagraphUnits(original, original, evidence, records, {
    chat: async (_model, messages) => {
      const request = JSON.parse(messages[1]!.content);
      seen.push(request.passage);
      assert.match(messages[0]!.content, /read-only recheck/i);
      return JSON.stringify({ action: 'keep', after: '', findings: [] });
    },
  }, [], 'draft-a');
  assert.deepEqual(seen, ['Second paragraph.']);
  const withRecheck = [...records, ...checked.results.map(result => ({
    stage: 'paragraphRecheck', result: { ...result as Record<string, unknown>, draftSignature: 'draft-a' },
  }))];
  assert.deepEqual(paragraphReviewCoverage(original, withRecheck, 'draft-a'), []);
  assert.equal(paragraphReviewCoverage(original, withRecheck, 'draft-b').length, 1);
});

test('a structural edit rechecks the affected field without rewriting it', async () => {
  const edited = { ...original, content: '<p>Only retained.</p>' };
  const records = [
    { stage: 'paragraphReview', result: { id: 'u1', field: 'content', before: 'First paragraph.', issues: [] } },
    { stage: 'paragraphReviewError', result: { id: 'u2', field: 'content' } },
    { stage: 'paragraphReview', result: { id: 'u3', field: 'title', before: original.title, issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u4', field: 'excerpt', before: original.excerpt, issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u5', field: 'summary', before: original.summary, issues: [] } },
  ];
  const seen: string[] = [];
  const checked = await recheckParagraphUnits(original, edited, evidence, records, {
    chat: async (_model, messages) => {
      seen.push(JSON.parse(messages[1]!.content).passage);
      return JSON.stringify({ action: 'keep', after: '', findings: [] });
    },
  }, [], 'changed-draft');
  assert.deepEqual(seen, ['Only retained.']);
  assert.deepEqual(checked.issues, []);
  assert.equal(edited.content, '<p>Only retained.</p>');
  const withRecheck = [...records, ...checked.results.map(result => ({
    stage: 'paragraphRecheck', result: { ...result as Record<string, unknown>, draftSignature: 'changed-draft' },
  }))];
  assert.deepEqual(paragraphReviewCoverage(original, withRecheck, 'changed-draft'), []);
});

test('a user-edited unit is rechecked even when its original review succeeded', async () => {
  const edited = { ...original, content: '<p>A user edit.</p><p>Second paragraph.</p>' };
  const records = [
    { stage: 'paragraphReview', result: { id: 'u1', field: 'content', before: 'First paragraph.', issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u2', field: 'content', before: 'Second paragraph.', issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u3', field: 'title', before: original.title, issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u4', field: 'excerpt', before: original.excerpt, issues: [] } },
    { stage: 'paragraphReview', result: { id: 'u5', field: 'summary', before: original.summary, issues: [] } },
  ];
  const seen: string[] = [];
  const checked = await recheckParagraphUnits(original, edited, evidence, records, {
    chat: async (_model, messages) => {
      seen.push(JSON.parse(messages[1]!.content).passage);
      return JSON.stringify({ action: 'unresolved', after: '',
        findings: [{ reason: 'Unsupported claim', claim: 'A user edit.', sourceIds: [] }] });
    },
  }, [], 'user-edit', undefined, undefined, undefined, original);
  assert.deepEqual(seen, ['A user edit.']);
  assert.match(checked.issues.join(' '), /Unsupported claim/);
  assert.equal(edited.content, '<p>A user edit.</p><p>Second paragraph.</p>');
});

test('final remediation sends one offending passage per request and performs a fresh review', async () => {
  let styleReviews = 0;
  const corrections: string[] = [];
  const result = await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
      const request = JSON.parse(messages[1]!.content);
      if (schema?.name === 'blog_passage_edits') {
        assert.equal(request.findings.length, 1);
        corrections.push(request.findings[0].before);
        return JSON.stringify({ edits: [{ id: request.findings[0].id, after: `Updated ${corrections.length}.`, remove: '' }] });
      }
      if (messages[0]!.content.includes('Review style') && ++styleReviews === 1) {
        return JSON.stringify({ findings: request.passages.filter((item: { field: string }) => item.field === 'content')
          .map((item: { id: string }) => ({ id: item.id, reason: 'Unclear', kind: 'style', claim: '', contradiction: '', sourceIds: [] })) });
      }
      return JSON.stringify({ findings: [] });
    },
  }, { checkpointParagraph: async () => {} });
  assert.deepEqual(corrections, ['First paragraph.', 'Second paragraph.']);
  assert.equal(styleReviews, 2);
  assert.equal(result.verification.verified, true);
});

test('a rejected correction still triggers fresh fact and style reviews', async () => {
  let facts = 0;
  let styles = 0;
  const result = await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
      const request = JSON.parse(messages[1]!.content);
      if (schema?.name === 'blog_passage_edits') {
        return JSON.stringify({ edits: [{ id: request.findings[0].id, after: '', remove: '' }] });
      }
      if (messages[0]!.content.includes('Review factual')) facts++;
      if (messages[0]!.content.includes('Review style') && ++styles === 1) {
        const passage = request.passages.find((item: { field: string }) => item.field === 'content');
        return JSON.stringify({ findings: [{ id: passage.id, reason: 'Unclear', kind: 'style', claim: '', contradiction: '', sourceIds: [] }] });
      }
      return JSON.stringify({ findings: [] });
    },
  }, { checkpointParagraph: async () => {} });
  assert.equal(facts, 2);
  assert.equal(styles, 2);
  assert.equal(result.verification.verified, false);
  assert.equal(result.draft.content, original.content);
});
