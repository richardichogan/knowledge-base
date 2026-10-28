import test from 'node:test';
import assert from 'node:assert/strict';
import { repairBlogDraft as runRepair, verifyBlogDraft as runVerify } from '../src/ai/blogEditorial.js';
import { writeBlogCandidate, type BlogDraft } from '../src/ai/blogDraft.js';
import type { FoundryClient } from '../src/ai/foundryClient.js';
import { assertVerifiedBlogJob, jobData, verifiedPost } from '../src/services/blogJobs.js';
import { parseBlogReviewBody, parsePublishBody } from '../src/services/blogPublisher.js';
import type { Pool } from 'pg';

const draft = (content: string): BlogDraft => ({
  title: 'Registry controls', excerpt: 'A new registry.', summary: 'Microsoft announced a registry.',
  content, keyTakeaways: [], categories: ['AI'], tags: ['Copilot'], postType: 'article', sourceUrl: null,
});
const evidence = JSON.stringify({ title: 'Registry', body: 'Microsoft announced a registry.' });

// Adapt the earlier combined-review fixtures to the separate, schema-shaped review calls.
function fixtureClient(client: Pick<FoundryClient, 'chat'>): Pick<FoundryClient, 'chat'> {
  let style: unknown[] = [];
  return { chat: async (model, messages, tokens, timeout, signal, schema) => {
    if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
    if (schema?.name === 'blog_review_findings' && messages[0]!.content.includes('Review style, length and coherence')) {
      return JSON.stringify({ findings: style });
    }
    const raw = await client.chat(model, messages, tokens, timeout, signal, schema);
    if (schema?.name === 'blog_review_findings') {
      const result = JSON.parse(raw) as { findings: Array<Record<string, unknown>> };
      const normalized = result.findings.map(item => ({
        id: item['id'], reason: item['reason'], kind: item['kind'],
        claim: item['claim'] ?? '', contradiction: item['contradiction'] ?? '', sourceIds: item['sourceIds'] ?? [],
      }));
      style = normalized.filter(item => item.kind === 'style' || item.kind === 'length' || item.kind === 'coherence');
      return JSON.stringify({ findings: normalized.filter(item => item.kind === 'accuracy' || item.kind === 'unsupported') });
    }
    if (schema?.name === 'blog_passage_edits') {
      const result = JSON.parse(raw) as { edits: Array<Record<string, unknown>> };
      return JSON.stringify({ edits: result.edits.map(item => ({ id: item['id'], after: item['after'] ?? '', remove: item['remove'] ?? '' })) });
    }
    return raw;
  } };
}

function repairBlogDraft(d: BlogDraft, e: string, save: (value: BlogDraft) => Promise<void>, client: Pick<FoundryClient, 'chat'>) {
  return runRepair(d, e, save, fixtureClient(client), { checkpointParagraph: async () => {} });
}
function verifyBlogDraft(d: BlogDraft, e: string, client: Pick<FoundryClient, 'chat'>) {
  return runVerify(d, e, fixtureClient(client));
}

function passageId(messages: Array<{ content: string }>, field: string, text: string): string {
  const request = JSON.parse(messages[1]!.content) as { passages: Array<{ id: string; field: string; before: string }> };
  const passage = request.passages.find(item => item.field === field && item.before.includes(text));
  assert.ok(passage, `No ${field} passage contains ${text}`);
  return passage.id;
}

test('a generated candidate with incomplete metadata is retained for correction', async () => {
  const client = { chat: async () => JSON.stringify({
    title: '', excerpt: '', summary: 'The source summary.', content: '<p>Draft content.</p>',
    categories: ['Unknown category'], tags: [], keyTakeaways: [],
  }) };
  const candidate = await writeBlogCandidate(client, 'write', '{}', false, null);
  assert.equal(candidate.title, '');
  assert.deepEqual(candidate.categories, ['Unknown category']);
});

test('draft generation rejects missing fields and empty content', async () => {
  await assert.rejects(writeBlogCandidate({ chat: async () => JSON.stringify({ content: '<p>Draft</p>' }) }, 'write', '{}', false, null), /required format/);
  await assert.rejects(writeBlogCandidate({ chat: async () => JSON.stringify({
    title: '', excerpt: '', summary: '', content: '<p></p>', keyTakeaways: [], categories: [], tags: [],
  }) }, 'write', '{}', false, null), /no article content/);
});

test('review requests schemas and rejects malformed structured responses', async () => {
  let calls = 0;
  await assert.rejects(runVerify(draft('<p>Microsoft announced a registry.</p>'), evidence, {
    chat: async (_model, _messages, _tokens, _timeout, _signal, schema) => {
      calls++;
      assert.equal(schema?.name, 'blog_review_findings');
      return JSON.stringify({ findings: [{ id: 'p1', reason: 'Missing required fields', kind: 'accuracy' }] });
    },
  }), /required format/);
  assert.equal(calls, 1);
});

test('stage records and a used remediation pass survive resumption without further corrections', async () => {
  const candidate = draft('<p>This is a game-changer.</p>');
  const stages: string[] = [];
  let corrections = 0;
  const result = await runRepair(candidate, evidence, async () => { throw new Error('Already used'); }, {
    chat: async (_model, _messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_passage_edits') corrections++;
      return JSON.stringify({ findings: [] });
    },
  }, { remediationUsed: true, record: async stage => { stages.push(stage); } });
  assert.equal(corrections, 0);
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /already been used/);
  assert.deepEqual(stages, ['factReviewStarted', 'factReview', 'styleReviewStarted', 'styleReview',
    'consolidation', 'validation', 'finalValidation']);
});

test('one structured remediation is recorded and later findings stay unresolved', async () => {
  const stages: string[] = [];
  let styleReviews = 0;
  let corrections = 0;
  const result = await runRepair(draft('<p>First issue. Second issue.</p>'), evidence, async () => {}, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_paragraph_review') return JSON.stringify({ action: 'keep', after: '', findings: [] });
      if (schema?.name === 'blog_passage_edits') {
        corrections++;
        const request = JSON.parse(messages[1]!.content);
        return JSON.stringify({ edits: [{ id: request.findings[0].id, after: 'First issue resolved.', remove: '' }] });
      }
      if (messages[0]!.content.includes('Review style, length and coherence')) {
        styleReviews++;
        const text = styleReviews === 1 ? 'First issue.' : 'Second issue.';
        return JSON.stringify({ findings: [{
          id: passageId(messages, 'content', text), reason: 'Wording needs review', kind: 'style',
          claim: '', contradiction: '', sourceIds: [],
        }] });
      }
      return JSON.stringify({ findings: [] });
    },
  }, { record: async stage => { stages.push(stage); }, checkpointParagraph: async () => {} });
  assert.equal(corrections, 1);
  assert.equal(result.verification.verified, false);
  assert.match(result.draft.content, /First issue resolved/);
  assert.ok(stages.includes('remediation'));
  assert.ok(stages.includes('finalValidation'));
});

test('repair sends only the flagged sentence and leaves surrounding content unchanged', async () => {
  const clean = 'Microsoft announced a registry.';
  const before = 'This is a game-changer.';
  const after = 'Administrators can review the registry.';
  const original = draft(`<p>${clean} ${before}</p><p>Another clean paragraph.</p>`);
  const requests: string[] = [];
  let call = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    requests.push(messages[1]!.content);
    call += 1;
    if (call === 1) return JSON.stringify({ findings: [{ id: passageId(messages, 'content', before), reason: 'Stock phrasing', kind: 'style', evidence: '' }] });
    if (call === 2) return JSON.stringify({ edits: [{ id: JSON.parse(messages[1]!.content).findings[0].id, after }] });
    return JSON.stringify({ findings: [] });
  } };
  const checkpoints: BlogDraft[] = [];
  const result = await repairBlogDraft(original, evidence, async value => { checkpoints.push(value); }, client);
  assert.equal(result.draft.content, `<p>${clean} ${after}</p><p>Another clean paragraph.</p>`);
  assert.equal(result.verification.verified, true);
  assert.equal(checkpoints.length, 1);
  assert.match(requests[1]!, /game-changer/);
  assert.doesNotMatch(requests[1]!, /Another clean paragraph/);
  assert.doesNotMatch(requests[1]!, /Microsoft announced a registry/);
});

test('ambiguous passage edits stay unchanged and block verification', async () => {
  const before = 'This is a game-changer.';
  const original = draft(`<p>${before} ${before}</p>`);
  let call = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    call++;
    if (call === 1) return JSON.stringify({ findings: [{ id: passageId(messages, 'content', before), reason: 'Stock phrasing', kind: 'style', evidence: '' }] });
    if (call === 2) return JSON.stringify({ edits: [{ id: JSON.parse(messages[1]!.content).findings[0].id, after: 'The registry is available.' }] });
    return JSON.stringify({ findings: [] });
  } };
  const result = await repairBlogDraft(original, evidence, async () => { throw new Error('Ambiguous edits must not be saved'); }, client);
  assert.equal(result.draft.content, original.content);
  assert.equal(result.verification.verified, false);
  assert.ok(result.verification.issues.length);
});

test('multiple findings on one saved sentence produce one targeted correction', async () => {
  const before = 'This is a game-changer.';
  let call = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    call += 1;
    if (call === 1) {
      const id = passageId(messages, 'content', before);
      return JSON.stringify({ findings: [
        { id, reason: 'Stock wording', kind: 'style', evidence: '' },
        { id, reason: 'Unclear claim', kind: 'style', evidence: '' },
      ] });
    }
    if (call === 2) {
      const request = JSON.parse(messages[1]!.content) as { findings: Array<{ id: string; before: string; reasons: string[] }> };
      assert.equal(request.findings.length, 1);
      assert.deepEqual(request.findings[0]!.reasons, ['Stock wording', 'Unclear claim']);
      assert.equal(request.findings[0]!.before, before);
      return JSON.stringify({ edits: [{ id: request.findings[0]!.id, after: 'The registry changes the process.' }] });
    }
    return JSON.stringify({ findings: [] });
  } };
  const result = await repairBlogDraft(draft(`<p>${before}</p>`), evidence, async () => {}, client);
  assert.equal(result.draft.content, '<p>The registry changes the process.</p>');
  assert.equal(result.verification.verified, true);
});

test('review cannot invent a sentence ID to change a saved draft', async () => {
  let calls = 0;
  const result = await repairBlogDraft(draft('<p>Microsoft announced a registry.</p>'), evidence, async () => {
    throw new Error('An unknown passage must never be saved');
  }, { chat: async () => {
    calls += 1;
    return JSON.stringify({ findings: [{ id: 'p9999', reason: 'Incorrect', kind: 'style', evidence: '' }] });
  } });
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /could not identify a specific saved passage/);
  assert.equal(calls, 1);
});

test('invalid findings do not prevent safe repairs or allow verification', async () => {
  const before = 'This is a game-changer.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${before}</p>`), evidence, async () => {}, {
    chat: async (_model, messages) => {
      calls++;
      if (calls === 1) return JSON.stringify({ findings: [
        { id: passageId(messages, 'content', before), reason: 'Stock wording', kind: 'style' },
        { id: 'p9999', reason: 'Unknown passage', kind: 'style' },
      ] });
      if (calls > 2) return JSON.stringify({ findings: [] });
      return JSON.stringify({ edits: [
        { id: JSON.parse(messages[1]!.content).findings[0].id, after: 'The registry changes the process.' },
      ] });
    },
  });
  assert.equal(result.draft.content, '<p>The registry changes the process.</p>');
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /invalid findings/);
  assert.doesNotMatch(result.verification.issues.join(' '), /Stock wording/);
  assert.equal(calls, 3);
});

test('accuracy repairs use only identified source passages', async () => {
  const before = 'The registry is generally available.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${before}</p>`),
    JSON.stringify({ text: 'The registry is in preview. An unrelated source sentence.' }), async () => {}, {
      chat: async (_model, messages) => {
        calls++;
        const request = JSON.parse(messages[1]!.content);
        if (calls === 1) return JSON.stringify({ findings: [{
          id: passageId(messages, 'content', before), reason: 'Availability', kind: 'accuracy',
          claim: before, contradiction: 'The source says the registry is in preview.',
          sourceIds: [request.source.text[0].id],
        }] });
        if (calls === 2) {
          assert.deepEqual(request.findings[0].evidence, ['The registry is in preview.']);
          assert.doesNotMatch(messages[1]!.content, /An unrelated source sentence/);
          return JSON.stringify({ edits: [{ id: request.findings[0].id, after: 'The registry is in preview.' }] });
        }
        return JSON.stringify({ findings: [] });
      },
    });
  assert.equal(result.draft.content, '<p>The registry is in preview.</p>');
  assert.equal(result.verification.verified, true);
});

test('unknown source IDs cannot authorize factual corrections', async () => {
  const before = 'The registry is generally available.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${before}</p>`), evidence,
    async () => { throw new Error('Unsupported corrections must not be saved'); }, {
      chat: async (_model, messages) => {
        calls++;
        return JSON.stringify({ findings: [{
          id: passageId(messages, 'content', before), reason: 'Availability', kind: 'accuracy', sourceIds: ['s9999'],
          claim: before, contradiction: 'The source does not establish general availability.',
        }] });
      },
    });
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /valid factual claim and source basis/);
  assert.equal(calls, 1);
});

test('a factual finding must identify the exact saved claim', async () => {
  const before = 'The registry is generally available.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${before}</p>`), evidence,
    async () => { throw new Error('Unmatched claims must not be changed'); }, {
      chat: async (_model, messages) => {
        calls++;
        return JSON.stringify({ findings: [{
          id: passageId(messages, 'content', before), reason: 'Availability cannot be verified',
          kind: 'unsupported', claim: 'A different claim.', sourceIds: [],
        }] });
      },
    });
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /valid factual claim and source basis/);
  assert.equal(calls, 1);
});

test('unsupported claim removal must actually include the identified claim', async () => {
  const before = 'Microsoft announced a registry, available to every customer.';
  const original = draft(`<p>${before}</p>`);
  let calls = 0;
  const result = await repairBlogDraft(original, evidence, async () => { throw new Error('Unrelated text must not be removed'); }, {
    chat: async (_model, messages) => {
      calls++;
      const request = JSON.parse(messages[1]!.content);
      if (calls === 1) return JSON.stringify({ findings: [{
        id: passageId(messages, 'content', before), reason: 'Availability cannot be verified',
        kind: 'unsupported', claim: 'available to every customer', sourceIds: [],
      }] });
      if (calls === 2) return JSON.stringify({ edits: [{ id: request.findings[0].id, remove: 'Microsoft announced a registry' }] });
      return JSON.stringify({ findings: [] });
    },
  });
  assert.equal(result.draft.content, original.content);
  assert.equal(result.verification.verified, false);
});

test('unsupported clauses are removed exactly and the revised draft is reviewed again', async () => {
  const before = 'Microsoft announced a registry, available to every customer.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${before} The original source is available.</p>`), evidence, async () => {}, {
    chat: async (_model, messages) => {
      const request = JSON.parse(messages[1]!.content);
      calls++;
      if (calls === 1) return JSON.stringify({ findings: [{
        id: passageId(messages, 'content', before), reason: 'Availability cannot be verified', kind: 'unsupported',
        claim: 'available to every customer', sourceIds: [],
      }] });
      if (calls === 2) {
        assert.equal(request.findings[0].removeOnly, true);
        assert.doesNotMatch(messages[1]!.content, /The original source is available/);
        return JSON.stringify({ edits: [{ id: request.findings[0].id, remove: ', available to every customer' }] });
      }
      assert.ok(request.removals.length);
      return JSON.stringify({ findings: [] });
    },
  });
  assert.equal(result.draft.content, '<p>Microsoft announced a registry. The original source is available.</p>');
  assert.equal(result.verification.verified, true);
  assert.equal(calls, 3);
});

test('a remaining coherence issue is retained after the single remediation pass', async () => {
  const unsupported = 'It is used by every customer.';
  const neighbour = 'They can inspect it.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${unsupported} ${neighbour}</p>`), evidence, async () => {}, {
    chat: async (_model, messages) => {
      const request = JSON.parse(messages[1]!.content);
      calls++;
      if (calls === 1) return JSON.stringify({ findings: [{
        id: passageId(messages, 'content', unsupported), reason: 'Adoption cannot be verified', kind: 'unsupported',
        claim: unsupported, sourceIds: [],
      }] });
      if (calls === 2) return JSON.stringify({ edits: [{ id: request.findings[0].id, remove: unsupported }] });
      if (calls === 3) {
        const id = passageId(messages, 'content', neighbour);
        assert.ok(request.coherenceEligibleIds.includes(id));
        return JSON.stringify({ findings: [{ id, reason: 'The pronoun no longer has a clear referent', kind: 'coherence', sourceIds: [] }] });
      }
      if (calls === 4) return JSON.stringify({ edits: [{ id: request.findings[0].id, after: 'The registry can be inspected.' }] });
      return JSON.stringify({ findings: [] });
    },
  });
  assert.equal(result.draft.content, `<p> ${neighbour}</p>`);
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /pronoun/);
  assert.equal(calls, 3);
});

test('unsupported claims cannot cause invented replacements or alter protected quotations', async () => {
  const before = 'Microsoft said "Every customer uses the registry."';
  let calls = 0;
  const original = draft(`<p>${before}</p>`);
  const result = await repairBlogDraft(original, evidence, async () => { throw new Error('Protected text must not be saved'); }, {
    chat: async (_model, messages) => {
      const request = JSON.parse(messages[1]!.content);
      calls++;
      if (calls === 1) return JSON.stringify({ findings: [{
        id: passageId(messages, 'content', before), reason: 'Quotation cannot be verified', kind: 'unsupported',
        claim: 'Every customer uses the registry.', sourceIds: [],
      }] });
      if (calls === 2) return JSON.stringify({ edits: [{ id: request.findings[0].id, remove: 'Every customer uses the registry.' }] });
      return JSON.stringify({ findings: [] });
    },
  });
  assert.equal(result.draft.content, original.content);
  assert.equal(result.verification.verified, false);
});

test('coherence findings after removal remain blocked after the single pass', async () => {
  const unsupported = 'It is used by every customer.';
  const unrelated = 'The final paragraph stands alone.';
  let calls = 0;
  const original = draft(`<p>${unsupported} The registry is described here. ${unrelated}</p>`);
  const result = await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages) => {
      const request = JSON.parse(messages[1]!.content);
      calls++;
      if (calls === 1) return JSON.stringify({ findings: [{
        id: passageId(messages, 'content', unsupported), reason: 'Adoption cannot be verified', kind: 'unsupported',
        claim: unsupported, sourceIds: [],
      }] });
      if (calls === 2) return JSON.stringify({ edits: [{ id: request.findings[0].id, remove: unsupported }] });
      return JSON.stringify({ findings: [{ id: passageId(messages, 'content', unrelated), reason: 'Unclear transition', kind: 'coherence' }] });
    },
  });
  assert.equal(result.verification.verified, false);
  assert.ok(result.draft.content.includes(unrelated));
  assert.equal(calls, 3);
});

test('a rejected correction cannot be hidden by another successful correction', async () => {
  const first = 'This is a game-changer.';
  const second = 'The process is seamless.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${first} ${second}</p>`), evidence, async () => {}, {
    chat: async (_model, messages) => {
      calls++;
      if (calls === 1) return JSON.stringify({ findings: [first, second].map(text => ({
        id: passageId(messages, 'content', text), reason: 'Stock wording', kind: 'style',
      })) });
      if (calls === 4) return JSON.stringify({ findings: [] });
      const request = JSON.parse(messages[1]!.content) as { findings: Array<{ id: string }> };
      return JSON.stringify({ edits: [{
        id: request.findings[0]!.id, after: calls === 2 ? 'The registry changes the process.' : '',
      }] });
    },
  });
  assert.equal(result.draft.content, `<p>The registry changes the process. ${second}</p>`);
  assert.equal(result.verification.verified, false);
  assert.match(result.verification.issues.join(' '), /did not match|did not return a correction/);
  assert.equal(calls, 4);
});

test('repair leaves later findings for human review after one pass', async () => {
  const first = 'This is a game-changer.';
  const second = 'The process is seamless.';
  const original = draft(`<p>${first} ${second}</p>`);
  const requests: string[] = [];
  let call = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    requests.push(messages[1]!.content);
    call += 1;
    if (call === 1 || call === 3) return JSON.stringify({ findings: [{
      id: passageId(messages, 'content', call === 1 ? first : second), reason: 'Stock phrasing', kind: 'style', evidence: '',
    }] });
    if (call === 2 || call === 4) return JSON.stringify({ edits: [{
      id: JSON.parse(messages[1]!.content).findings[0].id,
      after: call === 2 ? 'The registry changes the process.' : 'The process remains manageable.',
    }] });
    return JSON.stringify({ findings: [] });
  } };
  const result = await repairBlogDraft(original, evidence, async () => {}, client);
  assert.equal(result.verification.verified, false);
  assert.equal(call, 3);
  assert.doesNotMatch(requests[1]!, /seamless/);
});

test('repair stops after one pass even when more findings remain', async () => {
  const sentences = ['First issue.', 'Second issue.', 'Third issue.', 'Fourth issue.'];
  const original = draft(`<p>${sentences.join(' ')}</p>`);
  let calls = 0;
  const result = await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages) => {
      calls++;
      const request = JSON.parse(messages[1]!.content);
      if (calls % 2 === 1) {
        const index = (calls - 1) / 2;
        if (index === sentences.length) return JSON.stringify({ findings: [] });
        return JSON.stringify({ findings: [{
          id: passageId(messages, 'content', sentences[index]!), reason: 'Wording', kind: 'style',
        }] });
      }
      return JSON.stringify({ edits: [{ id: request.findings[0].id, after: `Resolved ${calls}.` }] });
    },
  });
  assert.equal(result.verification.verified, false);
  assert.equal(calls, 3);
});

test('repair does not perform a second correction that could restore an earlier draft', async () => {
  const original = draft('<p>First wording.</p>');
  let calls = 0;
  const result = await repairBlogDraft(original, evidence, async () => {}, {
    chat: async (_model, messages) => {
      calls++;
      const request = JSON.parse(messages[1]!.content);
      if (calls === 1 || calls === 3) return JSON.stringify({ findings: [{
        id: passageId(messages, 'content', calls === 1 ? 'First wording.' : 'Second wording.'),
        reason: 'Wording', kind: 'style',
      }] });
      return JSON.stringify({ edits: [{
        id: request.findings[0].id, after: calls === 2 ? 'Second wording.' : 'First wording.',
      }] });
    },
  });
  assert.equal(result.verification.verified, false);
  assert.equal(result.draft.content, '<p>Second wording.</p>');
  assert.equal(calls, 3);
});

test('an empty model review cannot override a local style failure', async () => {
  const result = await verifyBlogDraft(draft('<p>This is a game-changer.</p>'), evidence,
    { chat: async () => JSON.stringify({ findings: [] }) });
  assert.equal(result.verified, false);
  assert.ok(result.issues.some(issue => issue.includes('game-changer')));
});

test('article review prompts allow occasional rhetorical patterns and substantive lists', async () => {
  const triplet = 'Engineering process, policy, and evidence already meet.';
  const contrast = 'It is not a switch, it is a boundary.';
  const candidate = draft(`<p>${triplet} ${contrast}</p>`);
  const result = await verifyBlogDraft(candidate, evidence, {
    chat: async (_model, messages) => {
      assert.match(messages[0]!.content, /allow at most two/);
      return JSON.stringify({ findings: [] });
    },
  });
  assert.equal(result.verified, true);
});

test('article allowances count repeated occurrences across separate fields', async () => {
  const triplet = 'Engineering process, policy, and evidence already meet.';
  const contrast = 'It is not a switch, it is a boundary.';
  const candidate = { ...draft(`<p>${triplet} ${contrast} ${triplet} ${contrast}</p>`), summary: `${triplet} ${contrast}` };
  const result = await verifyBlogDraft(candidate, evidence, { chat: async () => JSON.stringify({ findings: [] }) });
  assert.equal(result.verified, false);
  assert.ok(!result.issues.some(issue => issue.startsWith('triplet list:')));
  assert.ok(result.issues.some(issue => issue.includes('construction')));
});

test('a review retains every finding beyond the former correction limit', async () => {
  const result = await verifyBlogDraft(draft('<p>Microsoft announced a registry.</p>'), evidence,
    { chat: async (_model, messages) => JSON.stringify({ findings: Array.from({ length: 21 }, (_, index) => ({
      id: passageId(messages, 'content', 'Microsoft announced a registry.'), reason: `Issue ${index}`, kind: 'style', evidence: '',
    })) }) });
  assert.equal(result.verified, false);
  assert.equal(result.issues.filter(issue => issue.startsWith('content:')).length, 21);
});

test('review accepts style defects without changing the text or weakening publication checks', () => {
  const post = { ...draft('<p>This is a game-changer — or so it seems.</p>'), status: 'draft' };
  assert.equal(parseBlogReviewBody(post).content, post.content);
  assert.throws(() => parsePublishBody(post), /banned AI writing patterns/);
});

test('review does not silently truncate an overlength saved excerpt', async () => {
  const candidate = { ...draft('<p>Microsoft announced a registry.</p>'), excerpt: 'A'.repeat(301) };
  assert.throws(() => parseBlogReviewBody({ ...candidate, status: 'draft' }), /exceeds 300 characters/);
  const result = await verifyBlogDraft(candidate, evidence, { chat: async () => JSON.stringify({ findings: [] }) });
  assert.equal(result.verified, false);
  assert.ok(result.issues.includes('The excerpt exceeds 300 characters.'));
  assert.equal(candidate.excerpt.length, 301);
});

test('a correction cannot alter a quoted passage', async () => {
  const before = 'This is a game-changer.';
  const original = draft(`<p>Microsoft said "${before}"</p>`);
  let call = 0;
  const client = { chat: async (_model: string, messages: Array<{ content: string }>) => {
    call++;
    if (call === 1) return JSON.stringify({ findings: [{ id: passageId(messages, 'content', before), reason: 'Wording', kind: 'style', evidence: '' }] });
    if (call === 2) return JSON.stringify({ edits: [{ id: JSON.parse(messages[1]!.content).findings[0].id, after: 'The registry is available.' }] });
    return JSON.stringify({ findings: [] });
  } };
  const result = await repairBlogDraft(original, evidence, async () => { throw new Error('Quoted text must not be changed'); }, client);
  assert.equal(result.draft.content, original.content);
  assert.equal(result.verification.verified, false);
  assert.ok(result.verification.issues.length);
});

test('source passages remain protected when evidence uses the text field', async () => {
  const before = 'This is a game-changer.';
  let calls = 0;
  const result = await repairBlogDraft(draft(`<p>${before}</p>`), JSON.stringify({ text: before }),
    async () => { throw new Error('Source text must not be changed'); }, {
      chat: async (_model, messages) => {
        calls++;
        if (calls === 1) return JSON.stringify({ findings: [{ id: passageId(messages, 'content', before), reason: 'Wording', kind: 'style' }] });
        if (calls === 2) return JSON.stringify({ edits: [{ id: JSON.parse(messages[1]!.content).findings[0].id, after: 'The registry changes the process.' }] });
        return JSON.stringify({ findings: [] });
      },
    });
  assert.equal(result.draft.content, `<p>${before}</p>`);
  assert.equal(result.verification.verified, false);
});

test('recheck is read-only and refuses missing source evidence', async () => {
  const messages: string[] = [];
  const candidate = draft('<p>Microsoft announced a registry.</p>');
  const result = await verifyBlogDraft(candidate, evidence, { chat: async (_model, input) => {
    messages.push(input[0]!.content);
    return JSON.stringify({ findings: [] });
  } });
  assert.equal(result.verified, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Do not rewrite/);
  await assert.rejects(verifyBlogDraft(candidate, 'invalid', { chat: async () => { throw new Error('Must not call model'); } }), /evidence is unavailable/);
});

test('publication requires the correct subject and exact verified content', async () => {
  const candidate = draft('<p>Microsoft announced a registry.</p>');
  const id = 'a0000000-0000-4000-8000-000000000001';
  const subjectId = 'discover:a0000000-0000-4000-8000-000000000002';
  const data = { ...jobData(id, subjectId, candidate, { verified: true, issues: [] }), verifiedSignature: verifiedPost(candidate) };
  const stages = ['content', 'title', 'excerpt', 'summary'].map((field, index) => ({
    stage: 'paragraphReview', result: {
      id: `u${index + 1}`, field,
      before: field === 'content' ? 'Microsoft announced a registry.' : candidate[field as 'title' | 'excerpt' | 'summary'],
      issues: [],
    },
  }));
  const db = { query: async () => ({ rows: [{ id, specialist: 'blog-writer', subject_id: subjectId, status: 'done',
    input: { blogCheckpoint: { originalDraft: candidate, stages } }, result: { data } }] }) } as unknown as Pool;
  const incompleteDb = { query: async () => ({ rows: [{ id, specialist: 'blog-writer', subject_id: subjectId, status: 'done',
    input: { blogCheckpoint: { originalDraft: candidate, stages: stages.slice(0, -1) } }, result: { data } }] }) } as unknown as Pool;
  const post = parsePublishBody({ ...candidate, sourceUrl: undefined, status: 'draft' });
  await assertVerifiedBlogJob(db, id, subjectId, post);
  await assert.rejects(assertVerifiedBlogJob(incompleteDb, id, subjectId, post), /not been verified/);
  await assert.rejects(assertVerifiedBlogJob(db, id, subjectId, { ...post, content: '<p>Changed content.</p>' }), /not been verified/);
  await assert.rejects(assertVerifiedBlogJob(db, id, 'spark-theme:a0000000-0000-4000-8000-000000000002', post), /not found/);
  await assert.rejects(assertVerifiedBlogJob(db, undefined, subjectId, post), /verified blog draft/);
});
