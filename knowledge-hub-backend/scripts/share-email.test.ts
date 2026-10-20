import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { PGlite } from '@electric-sql/pglite';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'fixture-sharing-encryption-key-not-a-real-secret';
const { shareEmailStatus, saveShareEmailConfig, sendShareEmail, validateShareEmail, SHARE_FROM } = await import('../src/services/shareEmail.js');
const boardUrl = 'https://app.mural.co/t/test/m/test/123';
const input = () => ({ requestId: crypto.randomUUID(), confirmed: true, recipients: ['one@example.com', 'TWO@example.com'],
  subject: 'Shared <diagram>', message: 'Please review <script>alert("x")</script>', url: boardUrl });
const settings = { username: 'athena.themicrosoftcloudblog.com', password: 'fixture-not-real', replyTo: 'replies@example.com' };
const result = (accepted = ['one@example.com', 'two@example.com'], rejected: string[] = []): SMTPTransport.SentMessageInfo => ({
  accepted, rejected, pending: [], envelope: { from: SHARE_FROM, to: accepted }, messageId: 'fixture-id', response: '250 accepted',
});
async function fixture() {
  const db = new PGlite();
  await db.exec('CREATE TABLE sync_state (source TEXT PRIMARY KEY, last_cursor TEXT, item_count INTEGER, updated_at TIMESTAMPTZ DEFAULT now())');
  const pool = { query: async (sql: string, params: unknown[]) => {
    const answer = await db.query(sql, params);
    return { rows: answer.rows, rowCount: answer.affectedRows ?? answer.rows.length };
  } } as unknown as Pool;
  return { db, pool };
}
test('SMTP2GO settings are encrypted and write-only, with fixed verified sender and EU TLS endpoint', async () => {
  const { pool, db } = await fixture();
  try {
    assert.equal((await shareEmailStatus(pool)).configured, false);
    const status = await saveShareEmailConfig(pool, settings);
    assert.equal(status.from, SHARE_FROM);
    assert.equal(status.host, 'mail-eu.smtp2go.com');
    assert.ok(!JSON.stringify(status).includes(settings.password));
    assert.ok(!JSON.stringify((await db.query('SELECT * FROM sync_state')).rows).includes(settings.password));
    await saveShareEmailConfig(pool, { ...settings, password: '' });
    assert.equal((await shareEmailStatus(pool)).configured, true);
    await assert.rejects(saveShareEmailConfig(pool, { ...settings, host: 'attacker.test' }));
    await assert.rejects(saveShareEmailConfig(pool, { ...settings, username: 'bad\r\nheader' }));
    await assert.rejects(saveShareEmailConfig(pool, { ...settings, replyTo: 'bad' }));
  } finally { await db.close(); }
});
test('Email validates explicit confirmation, recipient limits, trusted links and bounded draw.io XML', () => {
  assert.equal(validateShareEmail(input()).url, boardUrl);
  const file = { filename: 'IKEA – Architecture.drawio', xml: '<mxfile><diagram><mxGraphModel/></diagram></mxfile>' };
  assert.ok(validateShareEmail({ ...input(), url: '', attachment: file }).attachment?.content.equals(Buffer.from(file.xml)));
  const sizedXml = '<mxfile>' + ' '.repeat(4194304 - '<mxfile></mxfile>'.length) + '</mxfile>';
  assert.equal(validateShareEmail({ ...input(), attachment: { ...file, xml: sizedXml } }).attachment?.content.length, 4194304);
  assert.throws(() => validateShareEmail({ ...input(), attachment: { ...file, xml: sizedXml + ' ' } }));
  assert.equal(validateShareEmail({ ...input(), url: 'https://github.com/owner/repo/blob/main/note.md' }).url, 'https://github.com/owner/repo/blob/main/note.md');
  for (const change of [
    { confirmed: false }, { recipients: [] }, { recipients: Array(21).fill('one@example.com') }, { recipients: ['name <a@example.com>'] },
    { recipients: ['a@example.com\r\nBcc:b@example.com'] }, { subject: 'hi\ninjected' }, { message: 'x'.repeat(10001) },
    { url: 'https://evil.test/note.md' }, { url: 'https://github.com.evil.test/owner/repo/blob/main/note.md' },
    { url: 'https://app.mural.co/visitor/private' }, { url: '', attachment: undefined },
    { attachment: { ...file, filename: '../file.drawio' } }, { attachment: { ...file, filename: 'bad.exe' } },
    { attachment: { ...file, xml: '<mxfile>' } }, { attachment: { ...file, xml: '<!DOCTYPE mxfile><mxfile />' } },
    { attachment: { ...file, xml: 'x'.repeat(4194305) } },
  ]) assert.throws(() => validateShareEmail({ ...input(), ...change }));
});
test('Email sends an escaped preview with Bcc privacy, a real attachment and no automatic duplicate submission', async () => {
  const { pool, db } = await fixture();
  try {
    await saveShareEmailConfig(pool, settings);
    const data = { ...input(), attachment: { filename: 'diagram.drawio', xml: '<mxfile><diagram /></mxfile>' } };
    let calls = 0;
    const send = async (mail: Mail.Options) => {
      calls++;
      assert.deepEqual(mail.bcc, ['one@example.com', 'two@example.com']);
      assert.equal(mail.to, SHARE_FROM);
      assert.equal(mail.replyTo, 'replies@example.com');
      assert.deepEqual(mail.envelope, { from: SHARE_FROM, to: ['one@example.com', 'two@example.com'] });
      assert.equal(mail.disableUrlAccess, true);
      assert.equal(mail.disableFileAccess, true);
      assert.ok(String(mail.html).includes('&lt;script&gt;'));
      assert.ok(!String(mail.html).includes('<script>'));
      assert.ok(String(mail.text).includes(boardUrl));
      assert.ok(Buffer.isBuffer(mail.attachments?.[0]?.content));
      return result();
    };
    assert.deepEqual(await sendShareEmail(pool, 'user', data, send), { accepted: 2, rejected: 0 });
    assert.deepEqual(await sendShareEmail(pool, 'user', data, send), { accepted: 2, rejected: 0 });
    assert.equal(calls, 1);
    await assert.rejects(sendShareEmail(pool, 'user', { ...data, subject: 'changed' }, send), /already attempted/);
    assert.equal(calls, 1);
    const stored = JSON.stringify((await db.query("SELECT last_cursor FROM sync_state WHERE source LIKE 'share-email:%'")).rows);
    assert.ok(!stored.includes('one@example.com') && !stored.includes('Please review'));
  } finally { await db.close(); }
});
test('SMTP ambiguity and concurrent requests never automatically resend; partial recipient acceptance is explicit', async () => {
  const { pool, db } = await fixture();
  try {
    await saveShareEmailConfig(pool, settings);
    const data = input();
    let calls = 0;
    const smtpError = Object.assign(new Error('Sensitive provider response'), { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 });
    const fail = async () => { calls++; throw smtpError; };
    await assert.rejects(sendShareEmail(pool, 'user', data, fail), error => {
      assert.ok(error instanceof Error && error.message.includes('Delivery may be uncertain') && !error.message.includes('Sensitive'));
      assert.equal(error.cause, smtpError);
      return true;
    });
    await assert.rejects(sendShareEmail(pool, 'user', data, fail), /already attempted/);
    assert.equal(calls, 1);
    const next = input();
    assert.deepEqual(await sendShareEmail(pool, 'user', next, async () => result(['one@example.com'], ['two@example.com'])), { accepted: 1, rejected: 1 });
    const allRejected = input();
    await assert.rejects(sendShareEmail(pool, 'user', allRejected, async () => result([], ['one@example.com', 'two@example.com'])), /accepted no recipients/);
    await assert.rejects(sendShareEmail(pool, 'user', allRejected, fail), /already attempted/);
    assert.equal(calls, 1);
    const concurrent = input();
    let release!: () => void;
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = sendShareEmail(pool, 'user', concurrent, async () => { started(); await pending; return result(); });
    await sending;
    await assert.rejects(sendShareEmail(pool, 'user', concurrent, fail), /already attempted/);
    release(); await first;
    assert.equal(calls, 1);
  } finally { await db.close(); }
});
test('Failure to persist the SMTP outcome is explicit and cannot trigger a duplicate submission', async () => {
  const { pool, db } = await fixture();
  try {
    await saveShareEmailConfig(pool, settings);
    const broken = { query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('UPDATE sync_state')) throw new Error('sensitive DB detail');
      return pool.query(sql, params);
    } } as unknown as Pool;
    let calls = 0;
    const send = async () => { calls++; return result(); };
    const data = input();
    await assert.rejects(sendShareEmail(broken, 'user', data, send), /may already have been sent/);
    await assert.rejects(sendShareEmail(pool, 'user', data, send), /already attempted/);
    assert.equal(calls, 1);
  } finally { await db.close(); }
});
