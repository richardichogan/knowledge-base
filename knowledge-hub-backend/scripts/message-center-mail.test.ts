import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';

process.env['DATABASE_URL'] ??= 'postgresql://isolated.invalid/offline';
const { emailHtmlToText, parseMessageCenterEmail, isMessageCenterSender, messageCenterUrl, upsertMessageCenterPosts } =
  await import('../src/integrations/graph/messageCenterMail.js');

const MAJOR_HTML = `<html><head><style>p{color:red}</style></head><body>
<table><tr><td><p>View the description of the update.</p></td></tr>
<tr><td><h2>Microsoft Outlook: Themes by Copilot retirement</h2></td></tr>
<tr><td><span>MC1492954</span> &middot; THE MICROSOFT CLOUD BLOG</td></tr>
<tr><td>Tenant ID: 8f3872d4-3842-4413-87e3-86fdae13a9bb</td></tr>
<tr><td><h3>What and why</h3><p>We are retiring Themes by Copilot in Microsoft Outlook on 30&nbsp;November&nbsp;2026.</p>
<ul><li>No admin action required.</li></ul></td></tr></table></body></html>`.replace('&middot;', '·');

test('detects the Message Center sender', () => {
  assert.equal(isMessageCenterSender('O365MC@microsoft.com '), true);
  assert.equal(isMessageCenterSender('someone@microsoft.com'), false);
  assert.equal(isMessageCenterSender(undefined), false);
});

test('parses a major update email into title, MC id, and description', () => {
  const text = emailHtmlToText(MAJOR_HTML);
  assert.doesNotMatch(text, /color:red/);
  const posts = parseMessageCenterEmail(text, 'Major update from Message center');
  assert.equal(posts.length, 1);
  const [p] = posts;
  assert.equal(p?.mcId, 'MC1492954');
  assert.equal(p?.title, 'Microsoft Outlook: Themes by Copilot retirement');
  assert.equal(p?.major, true);
  assert.match(p?.body ?? '', /^What and why\nWe are retiring Themes by Copilot in Microsoft Outlook on 30 November 2026\.\n\n- No admin action required\.$/);
  assert.doesNotMatch(p?.body ?? '', /Tenant ID/);
  assert.equal(messageCenterUrl('MC1492954'), 'https://admin.microsoft.com/Adminportal/Home#/MessageCenter/:/messages/MC1492954');
});

test('splits a multi-post email and falls back to the subject when there is no layout', () => {
  const text = [
    'Weekly digest', '', 'Microsoft Teams: New meeting recap', 'MC1100001 · CONTOSO', 'Teams adds recaps.', '',
    'Exchange Online: Basic auth retirement', 'MC1100002 · CONTOSO', 'Tenant ID: x', 'Basic auth ends in March.',
  ].join('\n');
  const posts = parseMessageCenterEmail(text, 'Message center weekly digest');
  assert.deepEqual(posts.map((p) => [p.mcId, p.title, p.body, p.major]), [
    ['MC1100001', 'Microsoft Teams: New meeting recap', 'Teams adds recaps.', false],
    ['MC1100002', 'Exchange Online: Basic auth retirement', 'Basic auth ends in March.', false],
  ]);
  const fallback = parseMessageCenterEmail('See MC1234567 for details.', 'SharePoint change');
  assert.deepEqual(fallback.map((p) => [p.mcId, p.title]), [['MC1234567', 'SharePoint change']]);
  assert.deepEqual(parseMessageCenterEmail('No id here', 'Hello'), []);
});

test('stores each post once as a Microsoft Discover article', async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE content_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text, source_id text,
    title text, summary text, body text, published_at timestamptz, url text, project_context text, metadata jsonb, tags text[],
    updated_at timestamptz, indexed_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX ON content_items (url) WHERE source = 'discovered-article' AND url IS NOT NULL AND url != '';`);
  const db = { query: (sql: string, params?: unknown[]) => pg.query(sql, params) } as unknown as Pool;
  const posts = parseMessageCenterEmail(emailHtmlToText(MAJOR_HTML), 'Major update from Message center');
  assert.equal(await upsertMessageCenterPosts(db, posts, '2026-10-09T20:59:00Z'), 1);
  assert.equal(await upsertMessageCenterPosts(db, posts, '2026-10-09T20:59:00Z'), 0);
  const { rows } = await pg.query<{ title: string; source_id: string; url: string; metadata: Record<string, unknown> }>(
    `SELECT title, source_id, url, metadata FROM content_items`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, 'Microsoft Outlook: Themes by Copilot retirement (MC1492954)');
  assert.equal(rows[0]?.source_id, 'mc-MC1492954');
  assert.equal(rows[0]?.metadata['sourceGroup'], 'Microsoft');
  assert.equal(rows[0]?.metadata['sourceId'], 'message-center');
  assert.equal(rows[0]?.metadata['majorUpdate'], true);
  await pg.close();
});
