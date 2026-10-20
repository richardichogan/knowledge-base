import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'fixture-encryption-key-at-least-thirty-two-characters';
const {
  muralBoard, muralUploadUrl, pngDimensions, muralStatus, saveMuralConfig, startMuralAuth,
  finishMuralAuth, disconnectMural, exportMuralImage, MURAL_REDIRECT, MURAL_CLIENT_ID,
} = await import('../src/services/mural.js');

const boardUrl = 'https://app.mural.co/t/athena5676/m/athena5676/1792510867260';
const secret = 'fixture-mural-secret-not-real';
const config = { clientId: MURAL_CLIENT_ID, secret, boardUrl };

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE sync_state (
    source TEXT PRIMARY KEY, last_cursor TEXT, item_count INTEGER, updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    const result = await db.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  return { db, pool };
}
function png(): Buffer {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write('IHDR', 12); data.writeUInt32BE(640, 16); data.writeUInt32BE(480, 20);
  return data;
}
const tokenResponse = (seconds = 900) => new Response(JSON.stringify({
  access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: seconds,
}), { status: 200 });

test('Mural board parsing strips share tokens and rejects workspace/visitor/foreign URLs', () => {
  assert.deepEqual(muralBoard(`${boardUrl}/79b53c15c654bc5408f751d6ca0e7e84224b5a6b?sender=fixture#x`),
    { id: 'athena5676.1792510867260', url: boardUrl });
  for (const value of ['https://app.mural.co/t/athena5676/murals', 'https://evil.test/t/a/m/a/12',
    'http://app.mural.co/t/a/m/a/12', 'https://app.mural.co:444/t/a/m/a/12',
    'https://user:password@app.mural.co/t/a/m/a/12', 'https://app.mural.co/visitor/abc', [], null]) {
    assert.throws(() => muralBoard(value));
  }
  assert.equal(pngDimensions(png()).width, 640);
  assert.throws(() => pngDimensions(Buffer.from('not a png')));
  const huge = png(); huge.writeUInt32BE(20000, 16);
  assert.throws(() => pngDimensions(huge));
  assert.throws(() => pngDimensions(Buffer.alloc(21 * 1024 * 1024)));
});

test('Mural asset upload URLs allow only HTTPS Azure Blob storage and reject credential/redirect targets', () => {
  const url = 'https://fixture123.blob.core.windows.net/uploads/test.png?sig=fixture';
  assert.equal(muralUploadUrl(url), url);
  for (const value of ['http://fixture.blob.core.windows.net/x', 'https://127.0.0.1/x',
    'https://evil.test/x', 'https://fixture.blob.core.windows.net.evil.test/x',
    'https://user:pass@fixture.blob.core.windows.net/x', 'https://fixture.blob.core.windows.net:444/x']) {
    assert.throws(() => muralUploadUrl(value));
  }
});

test('Mural credentials are encrypted, write-only, retained on blank edit and validated', async () => {
  const { pool, db } = await fixture();
  try {
    const fresh = await muralStatus(pool);
    assert.equal(fresh.clientId, MURAL_CLIENT_ID);
    assert.equal(fresh.configured, false);
    const saved = await saveMuralConfig(pool, config);
    assert.equal(saved.configured, true); assert.equal(saved.connected, false);
    assert.ok(!JSON.stringify(saved).includes(secret));
    const rows = await db.query('SELECT last_cursor FROM sync_state');
    assert.ok(!JSON.stringify(rows).includes(secret));
    await saveMuralConfig(pool, { ...config, secret: '' });
    await assert.rejects(saveMuralConfig(pool, { ...config, clientId: 'bad' }));
    await assert.rejects(saveMuralConfig(pool, { ...config, boardUrl: 'https://evil.test' }));
    await assert.rejects(saveMuralConfig(pool, { ...config, secret: 'x\nx' }));
    await assert.rejects(saveMuralConfig(pool, { ...config, extra: true }));
    assert.equal((await muralStatus(pool)).configured, true);
  } finally { await db.close(); }
});

test('Mural OAuth uses exact callback, S256 PKCE, user-bound expiring one-use state and encrypted tokens', async () => {
  const { pool, db } = await fixture();
  const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    const url = new URL(await startMuralAuth(pool, 'richard'));
    assert.equal(url.origin, 'https://app.mural.co');
    assert.equal(url.searchParams.get('redirect_uri'), MURAL_REDIRECT);
    assert.equal(url.searchParams.get('scope'), 'murals:read murals:write');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const state = url.searchParams.get('state')!;
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.ok(String(input).endsWith('/authorization/oauth2/token'));
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get('client_secret'), secret);
      assert.equal(params.get('redirect_uri'), MURAL_REDIRECT);
      assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));
      return tokenResponse();
    };
    await finishMuralAuth(pool, 'richard', { state, code: 'fixture-code' });
    assert.equal(calls, 1);
    assert.equal((await muralStatus(pool)).connected, true);
    await assert.rejects(finishMuralAuth(pool, 'richard', { state, code: 'fixture-code' }), /already been used/);
    const rows = JSON.stringify((await db.query('SELECT last_cursor FROM sync_state')).rows);
    assert.ok(!rows.includes('fixture-access-token')); assert.ok(!rows.includes('fixture-refresh-token'));
    const other = new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state');
    await assert.rejects(finishMuralAuth(pool, 'someone-else', { state: other, code: 'x' }), /does not match/);
    assert.equal(calls, 1);
    const expired = new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state');
    await db.exec("UPDATE sync_state SET updated_at = NOW() - INTERVAL '11 minutes' WHERE source LIKE 'integration:mural:pending:%'");
    await assert.rejects(finishMuralAuth(pool, 'richard', { state: expired, code: 'x' }), /expired/);
    await disconnectMural(pool);
    assert.equal((await muralStatus(pool)).connected, false);
    assert.equal((await muralStatus(pool)).configured, true);
  } finally { globalThis.fetch = original; await db.close(); }
});

test('Mural provider denial consumes state and does not expose provider bodies or credentials', async () => {
  const { pool, db } = await fixture();
  const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    const state = new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state');
    globalThis.fetch = async () => new Response('provider body contains sensitive information', { status: 401 });
    await assert.rejects(finishMuralAuth(pool, 'richard', { state, code: 'x' }), /HTTP 401/);
    await assert.rejects(finishMuralAuth(pool, 'richard', { state, code: 'x' }), /already been used/);
    assert.equal((await muralStatus(pool)).connected, false);
  } finally { globalThis.fetch = original; await db.close(); }
});

test('Mural export refreshes tokens, uploads PNG without bearer leakage, then creates one image widget', async () => {
  const { pool, db } = await fixture();
  const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    globalThis.fetch = async () => tokenResponse(1);
    await finishMuralAuth(pool, 'richard', { state: new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state'), code: 'fixture' });
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      assert.equal(init?.redirect, 'error');
      if (url.endsWith('/authorization/oauth2/token')) {
        assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token');
        return tokenResponse();
      }
      if (url.includes('.blob.core.windows.net')) {
        assert.equal(init?.method, 'PUT');
        assert.ok(!JSON.stringify(init?.headers).includes('fixture-access-token'));
        assert.deepEqual(Buffer.from(init?.body as Uint8Array), png());
        return new Response('', { status: 201 });
      }
      assert.ok(JSON.stringify(init?.headers).includes('fixture-access-token'));
      if (url.endsWith('/assets')) return Response.json({ value: { url: 'https://fixture123.blob.core.windows.net/test.png?sig=fixture', name: 'fixture/test.png' } });
      if (url.endsWith('/widgets/image')) {
        const widget = JSON.parse(String(init?.body));
        assert.equal(widget.name, 'fixture/test.png'); assert.equal(widget.width, 640);
        assert.equal(widget.height, 480); assert.equal(widget.caption, 'Diagram test');
        assert.equal(widget.x, 100);
        return Response.json({ value: { id: 'fixture-widget' } }, { status: 201 });
      }
      return Response.json({ value: { id: 'athena5676.1792510867260' } });
    };
    assert.deepEqual(await exportMuralImage(pool, png(), boardUrl, 'Diagram test'), { boardUrl });
    assert.equal(calls.length, 5);
    assert.equal(calls.filter(url => url.endsWith('/widgets/image')).length, 1);
    // Changed credentials invalidate both tokens and pending authorisations.
    await startMuralAuth(pool, 'richard');
    await saveMuralConfig(pool, { ...config, secret: 'new-fixture-secret' });
    assert.equal((await muralStatus(pool)).connected, false);
    assert.equal((await db.query("SELECT * FROM sync_state WHERE source LIKE 'integration:mural:pending:%'")).rows.length, 0);
    await assert.rejects(exportMuralImage(pool, png(), boardUrl, 'Diagram test'), /Connect to Mural/);
  } finally { globalThis.fetch = original; await db.close(); }
});

test('Mural permission and storage failures never report success or create a widget', async () => {
  const { pool, db } = await fixture();
  const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    globalThis.fetch = async () => tokenResponse();
    await finishMuralAuth(pool, 'richard', { state: new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state'), code: 'fixture' });
    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(exportMuralImage(pool, png(), boardUrl, 'Diagram'), /permission/);
    let uploadCalls = 0;
    globalThis.fetch = async input => {
      if (String(input).endsWith('/assets')) return Response.json({ value: { url: 'https://evil.test/upload', name: 'x' } });
      uploadCalls++;
      return Response.json({ value: {} });
    };
    await assert.rejects(exportMuralImage(pool, png(), boardUrl, 'Diagram'), /Unsupported asset/);
    assert.equal(uploadCalls, 1);
    globalThis.fetch = async input => String(input).endsWith('/assets')
      ? Response.json({ value: { url: 'https://fixture123.blob.core.windows.net/x', name: 'x' } })
      : String(input).includes('.blob.core.windows.net') ? new Response('', { status: 500 }) : Response.json({ value: {} });
    await assert.rejects(exportMuralImage(pool, png(), boardUrl, 'Diagram'), /No image widget was created/);
  } finally { globalThis.fetch = original; await db.close(); }
});
