import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLIANCE_SCOPES, allianceScopes, scopesIncludeMailRead } from '../src/integrations/alliance/allianceGraph.js';
import { allianceInboxPath, allianceMessageToContentItem } from '../src/integrations/alliance/allianceMailSync.js';

test('Mail.Read is only requested when Alliance mail is enabled', () => {
  assert.equal(allianceScopes(false), ALLIANCE_SCOPES);
  assert.doesNotMatch(allianceScopes(false), /Mail/);
  assert.equal(allianceScopes(true), `${ALLIANCE_SCOPES} Mail.Read`);
});

test('granted scopes are checked for delegated Mail.Read only', () => {
  assert.equal(scopesIncludeMailRead('openid profile https://graph.microsoft.com/Mail.Read Files.Read.All'), true);
  assert.equal(scopesIncludeMailRead('Mail.Read User.Read'), true);
  assert.equal(scopesIncludeMailRead('Mail.Send Mail.ReadBasic Files.Read.All'), false);
  assert.equal(scopesIncludeMailRead(undefined), false);
});

test('inbox query covers the window and Alliance messages map to email items', () => {
  const path = allianceInboxPath(new Date('2026-09-15T00:00:00.000Z'));
  const [base, query] = path.split('?');
  assert.equal(base, '/me/mailFolders/inbox/messages');
  assert.equal(new URLSearchParams(query).get('$filter'), 'receivedDateTime ge 2026-09-15T00:00:00.000Z');
  const item = allianceMessageToContentItem({
    id: 'AAMk1', subject: null, bodyPreview: 'preview', body: { contentType: 'html', content: '<p>x</p>' },
    from: { emailAddress: { name: 'Jo', address: 'jo@ibm.com' } },
    receivedDateTime: '2026-10-14T08:00:00Z', webLink: 'https://outlook.office.com/x', isRead: false,
  }, 'Richard.i.Hogan@ibmalliance.onmicrosoft.com');
  assert.equal(item.source, 'email');
  assert.equal(item.sourceId, 'alliance-AAMk1');
  assert.equal(item.title, '[alliance] (no subject)');
  assert.match(item.body, /From: Jo <jo@ibm\.com>[\s\S]*preview$/);
  assert.deepEqual(item.tags, ['email', 'alliance']);
});
