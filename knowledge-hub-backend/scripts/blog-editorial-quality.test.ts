import test from 'node:test';
import assert from 'node:assert/strict';
import { finishPreparedBlogDraft, generateBlogDraft, generateIdeasBlogDraft, keepAllowedLinks, withSourceReference, type BlogDraft, type PreparedBlogDraft } from '../src/ai/blogDraft.js';
import { critiqueBlogCandidate, hasCurrentBlogEditorialReview, paragraphReviewCoverage, recheckParagraphUnits, repairBlogDraft, reviseBlogCandidate, reviewBlogArgument, verifyBlogDraft } from '../src/ai/blogEditorial.js';
import { isOfficialBlogDocumentation, researchBlogEvidence } from '../src/ai/blogResearch.js';
import type { FoundryClient } from '../src/ai/foundryClient.js';
import { anonymiseBlogAuthorContext } from '../src/ai/blogAuthorContext.js';
import { BLOG_ARGUMENT_RULES } from '../src/ai/blogHouseStyle.js';

const draft: BlogDraft = {
  title: 'A practical memory boundary', excerpt: 'A proposed control boundary.',
  summary: 'Check business facts at their source.',
  content: '<p>The guidance describes memory handling.</p><p>A hypothetical bank checks eligibility in its system of record.</p>',
  keyTakeaways: [], categories: ['AI'], tags: ['Foundry'], postType: 'article', sourceUrl: null,
};
const evidence = JSON.stringify({ title: 'Memory guidance', text: 'Memory is not a system of record.' });
const emptyFindings = JSON.stringify({ findings: [] });
const emptyEditorial = JSON.stringify({ findings: [], majorRisks: [] });
const official = 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/memory';
const documentation = 'Product documentation describing the supported scope and preview limitations. '.repeat(5);
const noSearch = {
  enabled: () => { throw new Error('Unnecessary search'); },
  tools: async () => [],
  search: async () => { throw new Error('Unnecessary search'); },
  read: async () => { throw new Error('Unnecessary read'); },
};

const teamDraft: BlogDraft = {
  ...draft, content: '<p>I would choose this control careful.</p><p>I would record the owner clear.</p>',
};

function teamCriticClient(): Pick<FoundryClient, 'chat'> {
  return {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_paragraph_review') {
        assert.match(messages[0]!.content, /read-only recheck.*Never propose an edit/s);
        return JSON.stringify({ action: 'keep', after: '', findings: [] });
      }
      if (schema?.name === 'blog_editorial_review') return emptyEditorial;
      assert.equal(schema?.name, 'blog_review_findings');
      if (!messages[0]!.content.includes('Review style, length and coherence')) return emptyFindings;
      const request = JSON.parse(messages[1]!.content) as { passages: Array<{ id: string; before: string }> };
      return JSON.stringify({ findings: request.passages.filter(item =>
        item.before === 'I would choose this control careful.' || item.before === 'I would record the owner clear.').map(item => ({
        id: item.id, reason: 'Correct the ungrammatical adverb.', kind: 'style', claim: '', contradiction: '', sourceIds: [],
      })) });
    },
  };
}

test('independent team critique is read-only and records full original paragraph coverage', async () => {
  const before = JSON.stringify(teamDraft);
  const result = await critiqueBlogCandidate(teamDraft, teamDraft, evidence, 'exact-editor-signature', teamCriticClient());
  assert.equal(JSON.stringify(teamDraft), before);
  assert.equal(result.verification.verified, true, 'Ordinary style findings remain advisory.');
  assert.equal(result.complete, true);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(paragraphReviewCoverage(teamDraft, result.stages, 'exact-editor-signature'), []);
  assert.equal(hasCurrentBlogEditorialReview(teamDraft, result.stages), true);
});

test('targeted team revision accepts one complete protected patch set without changing metadata', async () => {
  const critique = await critiqueBlogCandidate(teamDraft, teamDraft, evidence, 'editor-signature', teamCriticClient());
  const revised = await reviseBlogCandidate(teamDraft, evidence, critique, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      assert.equal(schema?.name, 'blog_passage_edits');
      const { finding } = JSON.parse(messages[1]!.content) as { finding: { id: string; before: string } };
      return JSON.stringify({ edits: [{ id: finding.id, after: finding.before.replace('careful.', 'carefully.').replace('clear.', 'clearly.'), remove: '' }] });
    },
  });
  assert.equal(revised.content, '<p>I would choose this control carefully.</p><p>I would record the owner clearly.</p>');
  assert.deepEqual({ ...revised, content: teamDraft.content }, teamDraft);
  assert.equal(teamDraft.content, '<p>I would choose this control careful.</p><p>I would record the owner clear.</p>');
});

test('a later invalid team edit rejects the entire candidate instead of partially saving an earlier edit', async () => {
  const critique = await critiqueBlogCandidate(teamDraft, teamDraft, evidence, 'editor-signature', teamCriticClient());
  const before = JSON.stringify(teamDraft);
  let calls = 0;
  await assert.rejects(reviseBlogCandidate(teamDraft, evidence, critique, {
    chat: async (_model, messages) => {
      calls++;
      const { finding } = JSON.parse(messages[1]!.content) as { finding: { id: string; before: string } };
      return JSON.stringify({ edits: [{ id: finding.id, after: calls === 1
        ? finding.before.replace('careful.', 'carefully.') : '<p>A whole replacement paragraph.</p>', remove: '' }] });
    },
  }), /unsafe.*No edit was applied/);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(teamDraft), before);
});

test('team revision refuses changed draft or evidence before making a model call', async () => {
  const critique = await critiqueBlogCandidate(teamDraft, teamDraft, evidence, 'editor-signature', teamCriticClient());
  const forbidden: Pick<FoundryClient, 'chat'> = { chat: async () => { throw new Error('A stale review must never dispatch authoring.'); } };
  await assert.rejects(reviseBlogCandidate({ ...teamDraft, title: 'User edited title' }, evidence, critique, forbidden), /changed after independent review/);
  await assert.rejects(reviseBlogCandidate(teamDraft, `${evidence} `, critique, forbidden), /changed after independent review/);
});

test('a critic that attempts paragraph edits cannot certify complete coverage or trigger author revision', async t => {
  t.mock.method(console, 'warn', () => {});
  const normal = teamCriticClient();
  const critique = await critiqueBlogCandidate(teamDraft, teamDraft, evidence, 'editor-signature', {
    chat: async (...args) => args[5]?.name === 'blog_paragraph_review'
      ? JSON.stringify({ action: 'replace', after: 'An unsolicited rewrite.', findings: [{
        reason: 'Rewrite this paragraph.', claim: 'control', sourceIds: [],
      }] })
      : normal.chat(...args),
  });
  assert.equal(critique.complete, false);
  assert.equal(critique.verification.verified, false);
  assert.ok(paragraphReviewCoverage(teamDraft, critique.stages, 'editor-signature').length);
  await assert.rejects(reviseBlogCandidate(teamDraft, evidence, critique, {
    chat: async () => { throw new Error('An incomplete critique must not dispatch the author.'); },
  }), /review is incomplete/);
});

test('separated author finalisation retains allowed links and the established exact source footer', () => {
  const prepared: PreparedBlogDraft = {
    system: '', user: '{}', quick: false, sourceUrl: official,
    reference: { title: 'Original & awkward source title', publishedAt: null }, allowedLinks: [official],
  };
  const candidate = { ...draft, content: `<p><a href="${official}">Documentation</a> and <a href="https://invalid.test">unapproved link</a>.</p>` };
  const result = finishPreparedBlogDraft(prepared, candidate);
  assert.equal(result.content, withSourceReference(keepAllowedLinks(candidate.content, [official]), prepared.reference!.title, official, null));
  assert.doesNotMatch(result.content, /href="https:\/\/invalid.test"/);
  assert.equal(candidate.content.includes('href="https://invalid.test"'), true);
});

test('a topic with no capability gap does not search or promote old research into primary evidence', async () => {
  const result = await researchBlogEvidence(JSON.stringify({
    text: 'A personal idea.', research: { documents: [{ text: 'Old research.' }] }, earlierPosts: [{ title: 'Voice only' }],
    authorContext: { insights: [{ text: 'Private practitioner context.' }] },
  }), {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      assert.equal(schema?.name, 'blog_research_plan');
      const request = JSON.parse(messages[1]!.content);
      assert.equal(request.source.research, undefined);
      assert.equal(request.source.earlierPosts, undefined);
      assert.equal(request.source.authorContext, undefined);
      return JSON.stringify({ queries: [] });
    },
  }, noSearch);
  assert.deepEqual(JSON.parse(result).research.documents, []);
  assert.deepEqual(JSON.parse(result).research.issues, []);
});

test('research reads official pages, not search snippets, and includes the current edit only as research context', async () => {
  let searches = 0;
  const result = await researchBlogEvidence(evidence, {
    chat: async (_model, messages) => {
      const request = JSON.parse(messages[1]!.content);
      assert.deepEqual(request.draftForResearchOnly, { title: draft.title, content: draft.content });
      return JSON.stringify({ queries: ['Microsoft Foundry memory supported capabilities'] });
    },
  }, {
    enabled: () => true,
    tools: async () => [{ type: 'function', function: { name: 'tavily_search', description: 'Search', parameters: { properties: { max_results: {}, include_domains: {} } } } }],
    search: async (_name, args) => {
      searches++;
      assert.equal(args['max_results'], 3);
      return { result: JSON.stringify({ results: [
        { title: 'Untrusted', url: 'https://learn.microsoft.com.evil.test/page', content: 'Invented feature.' },
        { title: 'Memory', url: official, content: 'A search snippet is not evidence.' },
      ] }) };
    },
    read: async url => {
      assert.equal(url, official);
      return { title: 'Memory capabilities', text: documentation, finalUrl: official };
    },
  }, draft);
  const saved = JSON.parse(result);
  assert.equal(searches, 1);
  assert.equal(saved.draftForResearchOnly, undefined);
  assert.equal(saved.research.documents.length, 1);
  assert.equal(saved.research.documents[0].text, documentation);
  assert.deepEqual(saved.research.issues, []);
  assert.doesNotMatch(result, /search snippet is not evidence|Invented feature/);
});

test('unavailable required research remains an explicit blocker even when the editor returns no defects', async () => {
  const result = await researchBlogEvidence(evidence, { chat: async () => JSON.stringify({ queries: ['Foundry memory scope'] }) }, {
    ...noSearch, enabled: () => false,
  });
  const checked = await reviewBlogArgument(draft, result, { chat: async () => emptyEditorial });
  assert.equal(checked.verified, false);
  assert.match(checked.issues.join(' '), /research is required.*unavailable/);
});

test('research rejects unreadable or redirected unofficial pages and never substitutes their snippets', async () => {
  let reads = 0;
  const result = await researchBlogEvidence(evidence, { chat: async () => JSON.stringify({ queries: ['Foundry memory scope'] }) }, {
    enabled: () => true,
    tools: async () => [{ type: 'function', function: { name: 'tavily_search', description: 'Search', parameters: {} } }],
    search: async () => ({ result: JSON.stringify({ results: [{ title: 'Memory', url: official, content: 'Available everywhere.' }] }) }),
    read: async () => { reads++; return { title: 'Moved', text: documentation, finalUrl: 'https://unofficial.example/memory' }; },
  });
  assert.equal(reads, 1);
  assert.equal(JSON.parse(result).research.documents.length, 0);
  assert.match(JSON.parse(result).research.issues.join(' '), /No readable official documentation/);
  assert.doesNotMatch(result, /Available everywhere/);
});

test('research validates its query bound and official HTTPS hosts', async () => {
  for (const raw of ['https://learn.microsoft.com.evil.test/x', 'http://learn.microsoft.com/x', 'https://user@learn.microsoft.com/x', 'https://learn.microsoft.com:8443/x']) {
    assert.equal(isOfficialBlogDocumentation(raw), false);
  }
  assert.equal(isOfficialBlogDocumentation(official), true);
  await assert.rejects(researchBlogEvidence(evidence, { chat: async () => JSON.stringify({ queries: ['one', 'two', 'three'] }) }, noSearch), /required format/);
});

test('argument and application improvements are advisory when facts have no major reputational risk', async () => {
  const before = structuredClone(draft);
  const stages: Array<{ stage: string; result: unknown }> = [];
  const checked = await verifyBlogDraft(draft, evidence, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name !== 'blog_editorial_review') return emptyFindings;
      assert.match(messages[0]!.content, /independent commissioning editor/);
      assert.match(messages[0]!.content, /label invented scenarios as hypothetical/);
      assert.match(messages[0]!.content, /preview\/GA/);
      return JSON.stringify({ majorRisks: [], findings: [
        { criterion: 'argument', reason: 'The body only repeats the source and makes no recommendation.', passage: '' },
        { criterion: 'application', reason: 'The example names a check but omits its failure response and suggested owner.', passage: '' },
      ] });
    },
  }, [], async (stage, result) => { stages.push({ stage, result }); });
  assert.equal(checked.verified, true);
  assert.deepEqual(checked.issues, []);
  assert.match(checked.warnings!.join(' '), /Editorial argument/);
  assert.match(checked.warnings!.join(' '), /Editorial application/);
  assert.deepEqual(draft, before);
  assert.equal(hasCurrentBlogEditorialReview(draft, stages), true);
});

test('a whole-piece pass is tied to the exact reviewed content and cannot be reused after editing', async () => {
  const stages: Array<{ stage: string; result: unknown }> = [];
  const result = await reviewBlogArgument(draft, evidence, { chat: async () => emptyEditorial }, [],
    async (stage, value) => { stages.push({ stage, result: value }); });
  assert.equal(result.verified, true);
  assert.equal(hasCurrentBlogEditorialReview(draft, stages), true);
  assert.equal(hasCurrentBlogEditorialReview({ ...draft, content: '<p>A different argument.</p>' }, stages), false);
  assert.equal(hasCurrentBlogEditorialReview(draft, []), false);
});

test('only concrete major reputational risks block an otherwise completed editorial review', async () => {
  for (const kind of ['material-falsehood', 'fabrication', 'confidential-disclosure', 'dangerous-advice']) {
    const stages: Array<{ stage: string; result: unknown }> = [];
    const result = await reviewBlogArgument(draft, evidence, {
      chat: async (_model, messages) => {
        assert.match(messages[0]!.content, /PUBLICATION POLICY/);
        assert.match(messages[0]!.content, /minor citation or naming discrepancies/);
        return JSON.stringify({ findings: [], majorRisks: [{
          kind, reason: 'A concrete material risk supported by the supplied evidence.', passage: draft.summary,
        }] });
      },
    }, [], async (stage, value) => { stages.push({ stage, result: value }); });
    assert.equal(result.verified, false);
    assert.match(result.issues.join(' '), new RegExp(kind));
    assert.equal(hasCurrentBlogEditorialReview(draft, stages), false);
  }
});

test('missing or invented major-risk assessments remain incomplete and never certify publication', async () => {
  for (const response of [
    { findings: [] },
    { findings: [], majorRisks: [{ kind: 'style', reason: 'Repeated phrasing.', passage: draft.summary }] },
    { findings: [], majorRisks: [{ kind: 'fabrication', reason: 'An invented quote.', passage: 'Not in this draft.' }] },
  ]) {
    await assert.rejects(reviewBlogArgument(draft, evidence, { chat: async () => JSON.stringify(response) }),
      /invalid findings after one retry/);
  }
});

test('passage concerns are assessed against the current draft and remain visible without automatically blocking', async () => {
  const concerns = ['The article repeats I would.', 'Minor source-name discrepancy.'];
  const result = await verifyBlogDraft(draft, evidence, {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name !== 'blog_editorial_review') return emptyFindings;
      assert.deepEqual(JSON.parse(messages[1]!.content).reviewConcerns, concerns);
      return emptyEditorial;
    },
  }, [], undefined, concerns);
  assert.equal(result.verified, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.warnings, concerns);
});

test('a completed paragraph with advisory findings is covered but a failed review is not', () => {
  const original = { ...draft, title: '', excerpt: '', summary: '', content: '<p>A clear position.</p>' };
  const result = { id: 'u1', field: 'content', kind: 'paragraph', before: 'A clear position.',
    action: 'unresolved', reviewed: true, issues: ['A wording suggestion.'] };
  assert.deepEqual(paragraphReviewCoverage(original, [{ stage: 'paragraphReview', result }]), []);
  assert.match(paragraphReviewCoverage(original, [{ stage: 'paragraphReview', result: { ...result, status: 'failed' } }]).join(' '), /incomplete/);
  assert.match(paragraphReviewCoverage(original, [{ stage: 'paragraphReview', result: { ...result, reviewed: false } }]).join(' '), /incomplete/);
});

test('malformed or invented editorial passages do not certify a draft', async () => {
  for (const raw of ['{}', JSON.stringify({ majorRisks: [], findings: [{ criterion: 'voice', reason: 'A defect.', passage: 'Text not in the draft.' }] })]) {
    await assert.rejects(reviewBlogArgument(draft, evidence, { chat: async () => raw }), /invalid findings after one retry/);
  }
});

test('editorial findings can quote rendered text across links and decoded entities without rewriting the draft', async () => {
  const candidate = { ...draft, content: `<p>The <a href="${official}">memory overview</a> describes retention &amp; deletion.</p>` };
  const stages: Array<{ stage: string; result: unknown }> = [];
  const result = await reviewBlogArgument(candidate, evidence, {
    chat: async (_model, messages) => {
      assert.match(messages[0]!.content, /Inspect HTML anchor href values/);
      assert.match(messages[0]!.content, /Do not report that paragraph as uncited/);
      return JSON.stringify({ majorRisks: [], findings: [{
        criterion: 'argument', reason: 'Explain the operational consequence of these controls.',
        passage: 'The memory overview describes retention & deletion.',
      }] });
    },
  }, [], async (stage, value) => { stages.push({ stage, result: value }); });
  assert.equal(result.verified, true);
  assert.match(result.warnings!.join(' '), /Editorial argument/);
  assert.ok(stages.some(item => item.stage === 'editorialReview'));
  assert.ok(!stages.some(item => item.stage === 'editorialReviewError'));
  assert.equal(candidate.content, `<p>The <a href="${official}">memory overview</a> describes retention &amp; deletion.</p>`);
});

test('an invalid editorial quotation receives one bounded retry with diagnostic context', async () => {
  let attempts = 0;
  const records: Array<{ stage: string; result: unknown }> = [];
  const invalid = JSON.stringify({ majorRisks: [], findings: [{ criterion: 'voice', reason: 'Repetition.', passage: 'Not in this draft.' }] });
  const result = await reviewBlogArgument(draft, evidence, {
    chat: async (_model, messages) => {
      attempts++;
      if (attempts === 1) return invalid;
      assert.match(JSON.parse(messages[1]!.content).previousValidationError, /does not occur in a draft field/);
      return emptyEditorial;
    },
  }, [], async (stage, value) => { records.push({ stage, result: value }); });
  assert.equal(attempts, 2);
  assert.equal(result.verified, true);
  const error = records.find(item => item.stage === 'editorialReviewError')?.result as { attempt: number; response: string };
  assert.equal(error.attempt, 1);
  assert.equal(error.response, invalid);
});

test('source titles and URLs are checked directly, including awkward punctuation, entities and site suffixes', async () => {
  const title = 'Remember, Retrieve, Revalidate-or Forget? Architecture & controls | Microsoft Community Hub';
  const url = 'https://techcommunity.microsoft.com/blog/example/source';
  const source = JSON.stringify({ title, url });
  const candidate = { ...draft, sourceUrl: url, content: withSourceReference(draft.content, title, url) };
  const result = await reviewBlogArgument(candidate, source, {
    chat: async (_model, messages) => {
      const request = JSON.parse(messages[1]!.content);
      assert.equal(request.citationCheck.verified, true);
      assert.equal(request.citationCheck.actual.title, title);
      assert.match(messages[0]!.content, /Do not return findings about that footer/);
      return emptyEditorial;
    },
  });
  assert.equal(result.verified, true);
  for (const [content, issue] of [
    [withSourceReference(draft.content, 'Altered title', url), /citation title differs/],
    [withSourceReference(draft.content, title, 'https://example.test/other'), /citation URL differs/],
    [draft.content, /citation is missing/],
  ] as const) {
    const checked = await reviewBlogArgument({ ...candidate, content }, source, { chat: async () => emptyEditorial });
    assert.equal(checked.verified, true);
    assert.match(checked.warnings!.join(' '), issue);
  }
});

test('contradictory source-title findings receive a correction retry, not an article defect', async () => {
  const title = 'Remember, Retrieve, Revalidate-or Forget? Architecting Memory | Microsoft Community Hub';
  const url = 'https://techcommunity.microsoft.com/blog/example/source';
  const candidate = { ...draft, content: withSourceReference(draft.content, title, url) };
  let attempts = 0;
  const checked = await reviewBlogArgument(candidate, JSON.stringify({ title, url }), {
    chat: async (_model, messages) => {
      if (++attempts === 1) return JSON.stringify({ majorRisks: [], findings: [{
        criterion: 'sources', reason: 'The source title is reproduced inaccurately.',
        passage: `<p><em>Source: <a href="${url}">${title}</a> (publication date unverified)</em></p>`,
        sourceCheck: { kind: 'citation', disputedText: title, documentationUrl: '', documentationQuote: '' },
      }] });
      assert.match(JSON.parse(messages[1]!.content).previousValidationError, /source-footer defect/);
      return emptyEditorial;
    },
  });
  assert.equal(attempts, 2);
  assert.equal(checked.verified, true);
  assert.deepEqual(checked.issues, []);
});

test('product-name findings must identify the disputed wording in its actual passage and quote supplied documentation', async () => {
  const candidate = { ...draft, content: '<p>Microsoft Community Hub has published an implementation architecture.</p><h2>Azure AI Foundry memory</h2>' };
  const source = JSON.stringify({ research: { issues: [], documents: [{
    url: official, text: 'Memory in Foundry Agent Service is a managed, long-term memory solution.',
  }] } });
  const sourceCheck = { kind: 'product-name', disputedText: 'Azure AI Foundry', documentationUrl: official,
    documentationQuote: 'Memory in Foundry Agent Service is a managed, long-term memory solution.' };
  const finding = { criterion: 'sources', reason: 'Use the documented service name in this heading.',
    passage: '<h2>Azure AI Foundry memory</h2>', sourceCheck };
  const valid = await reviewBlogArgument(candidate, source, { chat: async () => JSON.stringify({ majorRisks: [], findings: [finding] }) });
  assert.equal(valid.verified, true);
  assert.match(valid.warnings!.join(' '), /Use the documented service name/);
  for (const invalid of [
    { ...finding, passage: '<p>Microsoft Community Hub has published an implementation architecture.</p>' },
    { ...finding, sourceCheck: { ...sourceCheck, documentationQuote: 'The former product name is obsolete.' } },
    { ...finding, sourceCheck: { ...sourceCheck, documentationUrl: 'https://invented.example/doc' } },
  ]) {
    let attempts = 0;
    const checked = await reviewBlogArgument(candidate, source, {
      chat: async (_model, messages) => {
        if (++attempts === 1) return JSON.stringify({ majorRisks: [], findings: [invalid] });
        assert.match(JSON.parse(messages[1]!.content).previousValidationError, /product-name finding/);
        return emptyEditorial;
      },
    });
    assert.equal(attempts, 2);
    assert.equal(checked.verified, true);
  }
  await assert.rejects(reviewBlogArgument(candidate, source, {
    chat: async () => JSON.stringify({ majorRisks: [], findings: [{ ...finding, passage: '<p>Microsoft Community Hub has published an implementation architecture.</p>' }] }),
  }), /invalid findings after one retry/);
});

test('supported paragraph commentary cannot become an unresolved finding, including on recheck', async () => {
  let attempts = 0;
  const records: Array<{ stage: string; result: unknown }> = [];
  const original = { ...draft, content: '<p>The paragraph is supported.</p>' };
  const client: Pick<FoundryClient, 'chat'> = {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_editorial_review') return emptyEditorial;
      if (schema?.name !== 'blog_paragraph_review') return emptyFindings;
      const request = JSON.parse(messages[1]!.content);
      if (request.field !== 'content') return JSON.stringify({ action: 'keep', after: '', findings: [] });
      attempts++;
      if (attempts === 1) return JSON.stringify({ action: 'keep', after: '', findings: [{
        reason: 'The paragraph is supported by the source.', claim: '', sourceIds: [],
      }] });
      assert.match(request.previousValidationError, /Supporting commentary is not an unresolved issue/);
      return JSON.stringify({ action: 'keep', after: '', findings: [] });
    },
  };
  const result = await repairBlogDraft(original, evidence, async () => {}, client, {
    originalDraft: original,
    record: async (stage, value) => { records.push({ stage, result: value }); },
    checkpointParagraph: async (_saved, value) => { records.push({ stage: 'paragraphReview', result: value }); },
  });
  assert.equal(attempts, 2);
  assert.equal(result.verification.verified, true);
  assert.deepEqual(paragraphReviewCoverage(original, records), []);
  assert.doesNotMatch(result.verification.issues.join(' '), /supported by the source/);
  attempts = 0;
  const rechecked = await recheckParagraphUnits(original, original, evidence, [], client);
  assert.equal(attempts, 2);
  assert.deepEqual(rechecked.issues, []);
});

test('repeated contradictory keep responses remain a review-contract error, not a quoted positive defect', async () => {
  const checked = await recheckParagraphUnits(draft, draft, evidence, [], {
    chat: async (_model, messages) => JSON.stringify({ action: 'keep', after: '', findings: [{
      reason: 'The paragraph is supported.', claim: JSON.parse(messages[1]!.content).passage, sourceIds: [],
    }] }),
  });
  assert.ok(checked.issues.length);
  assert.match(checked.issues.join(' '), /failed after one retry/);
  assert.doesNotMatch(checked.issues.join(' '), /content: The paragraph is supported/);
});

test('Discover and Spark drafting enforce citation policy and retain source date provenance in both formats', async () => {
  const client: Pick<FoundryClient, 'chat'> = { chat: async (_model, _messages, _tokens, _timeout, _signal, schema) =>
    schema?.name === 'blog_research_plan' ? JSON.stringify({ queries: [] }) : emptyFindings };
  for (const length of ['short', 'long'] as const) {
    const writer = async (_client: Pick<FoundryClient, 'chat'>, system: string, user: string) => {
      assert.match(system, /practitioner argument/);
      assert.deepEqual(JSON.parse(user).research.queries, []);
      return { ...draft, postType: length === 'short' ? 'quick' as const : 'article' as const,
        content: '<p>Draft <a href="https://invented.example/page">claim</a>.</p>' };
    };
    const source = await generateBlogDraft({
      title: 'Original source', body: 'Facts.', source: 'discovered-article', url: 'https://example.test/source',
      publicationDateKnown: true, publishedAt: '2026-10-28T12:00:00Z',
    }, 'https://example.test/source', length, [], client, writer);
    const ideas = await generateIdeasBlogDraft('Memory', [{ body: 'A captured idea.', sourceTitle: null }], length, [], client, writer);
    assert.doesNotMatch(source.content, /invented.example/);
    assert.doesNotMatch(ideas.content, /invented.example/);
    assert.match(source.content, /feed publication date: 2026-10-28/);
  }
  assert.equal(keepAllowedLinks(`<p><a href="${official}">Documented scope</a> <a href="https://invented.example/page">claim</a></p>`, [official]),
    `<p><a href="${official}">Documented scope</a> claim</p>`);
  assert.match(withSourceReference('<p>Draft.</p>', 'Original & title', 'https://example.test/source'), /publication date unverified/);
});

test('author context preserves grounded positions and broad expertise without exposing raw source details', async () => {
  const records = [
    { id: 'a1', kind: 'profile' as const, ref: 'memory:profile', text: 'Richard is a Financial Services architect with work at Client Alpha.' },
    { id: 'a2', kind: 'user-message' as const, ref: 'chat:private', text: 'I would require eligibility checks against the system of record.' },
  ];
  const context = await anonymiseBlogAuthorContext(records, 'Agent memory', {
    chat: async (_model, messages, _tokens, _timeout, _signal, schema) => {
      if (schema?.name === 'blog_author_context') {
        assert.match(messages[0]!.content, /ANONYMISE/);
        assert.match(messages[0]!.content, /distinctive combinations/);
        return JSON.stringify({ insights: [
          { basis: 'background', text: 'Financial Services architecture experience.', sourceIds: ['a1'] },
          { basis: 'position', text: 'I would require eligibility checks against the system of record.', sourceIds: ['a2'] },
        ] });
      }
      assert.equal(schema?.name, 'blog_author_privacy');
      assert.match(messages[0]!.content, /even after names are removed/);
      return JSON.stringify({ assessments: [
        { index: 0, safe: true, reason: '' }, { index: 1, safe: true, reason: '' },
      ] });
    },
  });
  assert.equal(context.privacyChecked, true);
  assert.equal(context.insights.length, 2);
  assert.doesNotMatch(JSON.stringify(context), /Client Alpha|Richard is/);
  assert.deepEqual(context.sources.map(source => source.ref), ['memory:profile', 'chat:private']);
});

test('anonymisation fails closed on identifying details or invented experience', async () => {
  for (const issue of ['A precise date and location identify the engagement.', 'The source records only a question, not personal experience.']) {
    await assert.rejects(anonymiseBlogAuthorContext([
      { id: 'a1', kind: 'user-message', ref: 'chat:private', text: 'Could a bank use agent memory?' },
    ], 'Agent memory', {
      chat: async (_model, _messages, _tokens, _timeout, _signal, schema) => JSON.stringify(
        schema?.name === 'blog_author_context'
          ? { insights: [{ basis: 'experience', text: 'I implemented memory controls at a bank.', sourceIds: ['a1'] }] }
          : { assessments: [{ index: 0, safe: false, reason: issue }] }),
    }), /could not be anonymised and grounded safely/);
  }
});

test('private links, email addresses and invented provenance cannot reach the writer', async () => {
  for (const insight of [
    { basis: 'background', text: 'Contact person@example.test.', sourceIds: ['a1'] },
    { basis: 'background', text: 'Read https://private.example.test/engagement.', sourceIds: ['a1'] },
    { basis: 'position', text: 'I require a release gate.', sourceIds: ['invented'] },
  ]) {
    await assert.rejects(anonymiseBlogAuthorContext([
      { id: 'a1', kind: 'profile', ref: 'memory:profile', text: 'A practitioner profile.' },
    ], 'Agent memory', { chat: async () => JSON.stringify({ insights: [insight] }) }), /anonymised and grounded safely/);
  }
});

test('only individually checked insights survive, with their private provenance retained separately', async () => {
  const context = await anonymiseBlogAuthorContext([
    { id: 'a1', kind: 'profile', ref: 'memory:profile', text: 'Financial Services architect.' },
    { id: 'a2', kind: 'user-message', ref: 'chat:question', text: 'Could a bank use agent memory?' },
  ], 'Agent memory', {
    chat: async (_model, _messages, _tokens, _timeout, _signal, schema) => JSON.stringify(
      schema?.name === 'blog_author_context'
        ? { insights: [
          { basis: 'background', text: 'Financial Services architecture experience.', sourceIds: ['a1'] },
          { basis: 'experience', text: 'I implemented bank memory controls.', sourceIds: ['a2'] },
        ] }
        : { assessments: [
          { index: 1, safe: false, reason: 'A question does not establish personal experience.' },
          { index: 0, safe: true, reason: '' },
        ] }),
  });
  assert.equal(context.insights.length, 1);
  assert.equal(context.insights[0]!.basis, 'background');
  assert.equal(context.withheldInsights, 1);
  assert.deepEqual(context.sources.map(source => source.id), ['a1']);
});

test('incomplete or duplicated privacy assessments fail closed', async () => {
  for (const assessments of [[], [
    { index: 0, safe: true, reason: '' }, { index: 0, safe: true, reason: '' },
  ]]) {
    await assert.rejects(anonymiseBlogAuthorContext([
      { id: 'a1', kind: 'profile', ref: 'memory:profile', text: 'Financial Services architect.' },
    ], 'Agent memory', {
      chat: async (_model, _messages, _tokens, _timeout, _signal, schema) => JSON.stringify(
        schema?.name === 'blog_author_context'
          ? { insights: [{ basis: 'background', text: 'Financial Services architecture experience.', sourceIds: ['a1'] }] }
          : { assessments }),
    }), /privacy check did not complete/);
  }
});

test('background alone permits a proposed judgement but cannot become invented past experience', () => {
  assert.match(BLOG_ARGUMENT_RULES, /first-person design judgement/);
  assert.match(BLOG_ARGUMENT_RULES, /not an invented anecdote/);
  assert.match(BLOG_ARGUMENT_RULES, /communication style or preferred channel/);
  assert.match(BLOG_ARGUMENT_RULES, /Do not present chat-stated risk appetite as an acceptable durable conversational preference/);
  assert.match(BLOG_ARGUMENT_RULES, /KYC status or product eligibility/);
  assert.match(BLOG_ARGUMENT_RULES, /Never imply remembered risk appetite replaces a suitability assessment/);
  assert.match(BLOG_ARGUMENT_RULES, /what I require, refuse to sign off on/);
  assert.match(BLOG_ARGUMENT_RULES, /first-person attribution/);
});

test('writer and editorial review require varied first person, safe preferences and evidence-qualified preview implications', async () => {
  const before = structuredClone(draft);
  assert.match(BLOG_ARGUMENT_RULES, /Avoid repeated "I would"/);
  assert.match(BLOG_ARGUMENT_RULES, /preview alone does not prove there is no SLA/);
  assert.match(BLOG_ARGUMENT_RULES, /access date must match.*retrievedAt/);
  assert.match(BLOG_ARGUMENT_RULES, /not a personal or human verification claim/);
  assert.match(BLOG_ARGUMENT_RULES, /connectors such as "otherwise".*explicit logical antecedent/);
  assert.match(BLOG_ARGUMENT_RULES, /do not invent a service’s identity model/);
  await reviewBlogArgument(draft, evidence, {
    chat: async (_model, messages) => {
      const instructions = messages[0]!.content;
      assert.match(instructions, /even with a suitability disclaimer/);
      assert.match(instructions, /Do not demand a claim of no SLA or prohibited production use without evidence/);
      assert.match(instructions, /no arbitrary phrase-count quota/);
      assert.match(instructions, /dangling logical connectors/);
      return emptyEditorial;
    },
  });
  assert.deepEqual(draft, before);
});

test('preview terms research remains within existing bounds and does not assume blanket restrictions', async () => {
  await researchBlogEvidence(evidence, {
    chat: async (_model, messages) => {
      assert.match(messages[0]!.content, /applicable production-use terms, support\/SLA commitments/);
      assert.match(messages[0]!.content, /within the same query\/document bounds/);
      assert.match(messages[0]!.content, /never assume all previews share the same conditions/);
      return JSON.stringify({ queries: [] });
    },
  }, noSearch);
});
