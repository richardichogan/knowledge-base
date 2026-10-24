import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { publishingFixture } from './publishing-fixture.js';
import { getDb, closeDb } from '../src/db/db.js';
import { editorialServices, reviewDraft, parseDraftContent } from '../src/publishing/editorial.js';
import { saveDraft, topicColumns, topicDetail } from '../src/publishing/store.js';
import type { Topic, Source } from '../src/publishing/contracts.js';

if (process.env['PUBLISHING_EVAL_LIVE'] !== 'approved') {
  throw new Error('Live publishing evaluation requires PUBLISHING_EVAL_LIVE=approved. Only synthetic evidence and an isolated database are used; nothing is published.');
}
const telemetry = mock.method(getDb(), 'query', async () => ({ rows: [] }));
const fixture = await publishingFixture();
const startedAt = new Date().toISOString();
const sourceText = `Reference fixture about an established Microsoft Entra administration workflow, not a new product announcement.
Microsoft Entra Conditional Access supports report-only policies. A report-only policy evaluates its configured conditions without enforcing its access controls.
Administrators can inspect policy results in the sign-in logs before enabling enforcement. A successful report-only evaluation is not evidence that every future sign-in will behave the same way.
The practical purpose is to understand the effect of a policy before enforcing it. Administrators still need to assess the intended scope.
This source makes no measured cost-saving claims and contains no customer stories or first-hand consulting experience.
This is a limited reference about report-only evaluation, not a claim that a specific policy is safe or that a tenant has been audited.`;
let calls = 0;
const service = {
  ...editorialServices,
  preferences: async () => '',
  chat: async (...args: Parameters<typeof editorialServices.chat>) => {
    assert.ok(++calls <= 18, 'Live evaluation call budget exceeded');
    return editorialServices.chat(...args);
  },
};
try {
  const topic = (await fixture.db.query<Topic>(`INSERT INTO publishing_topics(title,fingerprint,state)
    VALUES('Microsoft Entra report-only reference fixture','synthetic-live-eval','ready') RETURNING ${topicColumns}`)).rows[0]!;
  const source: Source = {
    itemId: topic.id, topicId: topic.id, title: 'Microsoft Entra report-only reference evidence', url: 'https://source.fixture.invalid/entra',
    body: sourceText, readAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
  };
  await saveDraft(fixture.db, topic.id, 'bluesky', 'source', { account: 'fixture.bsky.social' },
    new Date(Date.now() + 3600000).toISOString(), false);
  const missing = (await topicDetail(fixture.db, topic.id)).drafts[0]!;
  await reviewDraft(fixture.db, missing, [source], service);
  const recovered = (await topicDetail(fixture.db, topic.id)).drafts[0]!;
  assert.equal(typeof recovered.content.copy, 'string');
  assert.ok(String(recovered.content.copy).trim().length > 0);
  assert.ok(recovered.version >= 2);
  assert.ok(['pass', 'hold'].includes(recovered.review), 'Real editorial checks must finish or explicitly hold the draft');
  if (recovered.review === 'pass') parseDraftContent('bluesky', recovered.content);
  else assert.ok(recovered.reason.trim(), 'A held draft must explain why it is not ready');
  assert.equal(recovered.approval, 'pending');
  await saveDraft(fixture.db, topic.id, 'blog', 'blog', {
    title: 'Checking an Entra policy before enforcement', summary: 'An administration reference example.',
    content: '<p>We saved clients 40% by turning on Microsoft Entra report-only policies.</p>',
    excerpt: 'An administration reference example.', keyTakeaways: [], categories: [], tags: [], postType: 'article', account: 'fixture.invalid',
  }, new Date(Date.now() + 3600000).toISOString(), false);
  const original = (await topicDetail(fixture.db, topic.id)).drafts.find(draft => draft.destination === 'blog')!;
  await reviewDraft(fixture.db, original, [source], service);
  const revised = (await topicDetail(fixture.db, topic.id)).drafts.find(draft => draft.destination === 'blog')!;
  assert.equal(revised.approval, 'pending');
  assert.ok(['pass', 'hold'].includes(revised.review));
  if (revised.review === 'pass') {
    const valid = parseDraftContent('blog', revised.content);
    assert.ok(!/40%|saved clients/i.test(String(valid.content)));
  }
  assert.equal((await fixture.db.query('SELECT * FROM publishing_deliveries')).rows.length, 0);
  console.log(JSON.stringify({
    startedAt, completed: true, readyForScheduling: recovered.review === 'pass' && revised.review === 'pass',
    syntheticOnly: true, productionWrites: false, publishedPosts: 0, modelCalls: calls,
    missingCopyRecovered: true, accuracyAndVoice: recovered.review, approval: recovered.approval,
    blogEditorialOutcome: revised.review, blogVersions: revised.version, blogRemainsUnapproved: true,
  }, null, 2));
} finally {
  telemetry.mock.restore();
  await fixture.close();
  await closeDb();
}
