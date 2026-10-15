import assert from 'node:assert/strict';
import test from 'node:test';
import { emailAccountConnections } from '../src/integrations/email/accountConnections.js';

test('requested email accounts are listed without claiming mailbox access', () => {
  const accounts = emailAccountConnections('Richard.i.Hogan@ibmalliance.onmicrosoft.com', undefined);
  assert.deepEqual(accounts.map((a) => a.email), [
    'Richard.i.Hogan@ibmalliance.onmicrosoft.com', 'richard_hogan@hotmail.co.uk', 'richardichogan@gmail.com',
  ]);
  assert.ok(accounts.every((a) => a.status === 'not-connected'));
  assert.match(accounts[0]!.detail, /turned off.*does not grant mail/);
});

test('uses configured Alliance UPN and never returns IMAP credentials or other accounts', () => {
  const accounts = emailAccountConnections('correct@tenant.onmicrosoft.com', JSON.stringify([
    { email: 'RICHARDICHOGAN@gmail.com', host: 'imap.gmail.com', user: 'user', pass: 'secret-sentinel' },
    { email: 'unrelated@example.com', host: 'imap.example.com', user: 'other', pass: 'another-secret' },
    { email: 'richard_hogan@hotmail.co.uk', host: 'outlook.office365.com' },
  ]));
  assert.equal(accounts[0]?.email, 'correct@tenant.onmicrosoft.com');
  assert.equal(accounts[2]?.status, 'configured');
  assert.equal(accounts[1]?.status, 'not-connected');
  assert.doesNotMatch(JSON.stringify(accounts), /secret-sentinel|another-secret|unrelated@example/);
  assert.match(accounts[2]!.detail, /does not verify access/);
});

test('invalid configuration is reported, not silently shown as disconnected', () => {
  assert.throws(() => emailAccountConnections(undefined, '{'), SyntaxError);
  assert.throws(() => emailAccountConnections(undefined, '{}'), /must be an array/);
  assert.throws(() => emailAccountConnections(undefined, '[null]'), /invalid account/);
});

test('Alliance mail status reflects the flag and the granted scope', () => {
  const upn = 'Richard.i.Hogan@ibmalliance.onmicrosoft.com';
  const enabledNoGrant = emailAccountConnections(upn, undefined, { enabled: true, mailAccess: false })[0]!;
  assert.equal(enabledNoGrant.status, 'not-connected');
  assert.match(enabledNoGrant.detail, /no Mail\.Read.*Reconnect Alliance/);
  const granted = emailAccountConnections(upn, undefined, { enabled: true, mailAccess: true })[0]!;
  assert.equal(granted.status, 'configured');
  assert.match(granted.detail, /Mail\.Read is granted/);
  assert.equal(emailAccountConnections(upn, undefined, { enabled: false, mailAccess: true })[0]!.status, 'not-connected');
});
