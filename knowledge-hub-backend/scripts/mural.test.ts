import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'fixture-encryption-key-at-least-thirty-two-characters';
const {
  muralBoard, muralUploadUrl, pngDimensions, muralStatus, saveMuralConfig, startMuralAuth,
  finishMuralAuth, disconnectMural, exportMuralImage, listMuralBoards, MURAL_REDIRECT, MURAL_CLIENT_ID,
} = await import('../src/services/mural.js');
const { exportMuralDiagram, validateMuralDiagram } = await import('../src/services/muralDiagram.js');

const boardUrl = 'https://app.mural.co/t/athena5676/m/athena5676/1792510867260';
const secret = 'fixture-mural-secret-not-real';
const config = { clientId: MURAL_CLIENT_ID, secret, boardUrl };

function nativeDiagram() {
  const base = { shape: 'rectangle', text: 'Editable <label>', x: 120, y: 140, width: 160, height: 80, parentId: null,
    fill: '#FFFFFFFF', stroke: '#161616FF', strokeWidth: 2, dotted: false, textColor: '#161616FF', fontSize: 14, align: 'center' };
  return { boardUrl, title: 'Native diagram', objects: [
    { ...base, id: 'child', type: 'shape', parentId: 'area' },
    { ...base, id: 'area', type: 'area', x: 100, y: 100, width: 600, height: 300 },
    { ...base, id: 'target', type: 'shape', x: 800 },
    { ...base, id: 'text', type: 'textbox', text: '<script>alert("x")</script>', y: 500 },
  ], connectors: [{ id: 'edge', sourceId: 'child', targetId: 'target', points: [{ x: 280, y: 180 }, { x: 800, y: 180 }],
    route: 'orthogonal', arrows: 'start', stroke: '#161616FF', strokeWidth: 2, dashed: true, text: 'Editable edge', fontSize: 12, label: { x: 540, y: 180 } }] };
}

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

test('Mural lists every workspace and board page, groups names and retains archived boards without exposing sharing tokens', async () => {
  const { pool, db } = await fixture(); const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    globalThis.fetch = async () => tokenResponse();
    const auth = new URL(await startMuralAuth(pool, 'richard'));
    assert.equal(auth.searchParams.get('scope'), 'murals:read murals:write workspaces:read');
    await finishMuralAuth(pool, 'richard', { state: auth.searchParams.get('state'), code: 'fixture' });
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); calls.push(url.pathname + url.search);
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access-token');
      assert.equal(url.searchParams.get('limit'), '100');
      if (url.pathname.endsWith('/workspaces')) return Response.json(url.searchParams.has('next')
        ? { value: [{ id: 'other1234', name: 'Alpha workspace' }] }
        : { value: [{ id: 'athena5676', name: 'Main workspace' }], next: 'workspace+/token' });
      if (url.pathname.endsWith('/athena5676/murals')) return Response.json(url.searchParams.has('next')
        ? { value: [{ id: 'athena5676.2', title: 'Archived board', status: 'archived' }] }
        : { value: [{ id: 'athena5676.1', title: 'Project board', status: 'active', state: 'private-visitor-key' }], next: 'boards+/token' });
      assert.ok(url.pathname.endsWith('/other1234/murals'));
      return Response.json({ value: [{ id: 'other1234.3', title: 'Project board', status: 'active' }] });
    };
    const boards = await listMuralBoards(pool);
    assert.deepEqual(boards, [
      { id: 'other1234.3', title: 'Project board', workspace: 'Alpha workspace', archived: false, url: 'https://app.mural.co/t/other1234/m/other1234/3' },
      { id: 'athena5676.2', title: 'Archived board', workspace: 'Main workspace', archived: true, url: 'https://app.mural.co/t/athena5676/m/athena5676/2' },
      { id: 'athena5676.1', title: 'Project board', workspace: 'Main workspace', archived: false, url: 'https://app.mural.co/t/athena5676/m/athena5676/1' },
    ]);
    assert.equal(calls.length, 5);
    assert.ok(calls.some(call => new URL(`https://fixture.test${call}`).searchParams.get('next') === 'boards+/token'));
    assert.ok(!JSON.stringify(boards).includes('private-visitor-key'));
  } finally { globalThis.fetch = original; await db.close(); }
});

test('Mural board listing surfaces missing scope, malformed pages, failed pages and pagination loops instead of returning partial success', async () => {
  const { pool, db } = await fixture(); const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    globalThis.fetch = async () => tokenResponse();
    await finishMuralAuth(pool, 'richard', { state: new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state'), code: 'fixture' });
    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(listMuralBoards(pool), /workspaces:read.*reconnect/);
    globalThis.fetch = async () => Response.json({ value: 'invalid' });
    await assert.rejects(listMuralBoards(pool), /invalid board list/);
    globalThis.fetch = async () => Response.json({ value: [], next: 'repeated' });
    await assert.rejects(listMuralBoards(pool), /repeated a pagination token/);
    globalThis.fetch = async input => String(input).includes('/workspaces?')
      ? Response.json({ value: [{ id: 'athena5676', name: 'Workspace' }] })
      : new Response('', { status: 429 });
    await assert.rejects(listMuralBoards(pool), /429.*Wait/);
    globalThis.fetch = async () => Response.json({ value: [{ id: 'invalid/workspace', name: 'Invalid' }] });
    await assert.rejects(listMuralBoards(pool), /invalid workspace/);
    await disconnectMural(pool);
    await assert.rejects(listMuralBoards(pool), /Connect to Mural/);
  } finally { globalThis.fetch = original; await db.close(); }
});

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

test('Native Mural validates the full diagram, hierarchy, IDs, colours and limits before writing', () => {
  assert.equal(validateMuralDiagram(nativeDiagram()).objects.length, 4);
  const standalone = nativeDiagram();
  standalone.objects = [];
  const line = standalone.connectors[0]!;
  assert.equal(validateMuralDiagram({ ...standalone, connectors: [{ ...line, sourceId: null, targetId: null }] }).connectors.length, 1);
  for (const mutate of [
    (d: ReturnType<typeof nativeDiagram>) => { d.objects[0]!.parentId = 'child'; },
    (d: ReturnType<typeof nativeDiagram>) => { d.connectors[0]!.sourceId = 'missing'; },
    (d: ReturnType<typeof nativeDiagram>) => { d.objects[0]!.width = NaN; },
    (d: ReturnType<typeof nativeDiagram>) => { d.objects[0]!.fill = 'red'; },
    (d: ReturnType<typeof nativeDiagram>) => { d.objects[0]!.shape = 'invalid'; },
    (d: ReturnType<typeof nativeDiagram>) => { d.objects[0]!.id = 'area'; },
    (d: ReturnType<typeof nativeDiagram>) => { d.objects = Array.from({ length: 201 }, () => d.objects[0]!); },
  ]) {
    const diagram = nativeDiagram(); mutate(diagram);
    assert.throws(() => validateMuralDiagram(diagram));
  }
});

test('Native Mural uploads only individual icons and never forwards OAuth to asset storage', async () => {
  const { pool, db } = await fixture(); const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    globalThis.fetch = async () => tokenResponse();
    await finishMuralAuth(pool, 'richard', { state: new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state'), code: 'fixture' });
    const icon = { ...nativeDiagram().objects[0]!, id: 'icon', parentId: null, type: 'image', image: `data:image/png;base64,${png().toString('base64')}` };
    const diagram = { ...nativeDiagram(), objects: [icon], connectors: [] };
    let widgets = 0; let failUpload = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/assets')) return Response.json({ value: { url: 'https://fixture.blob.core.windows.net/icon.png?sig=fixture', name: 'icon.png' } });
      if (url.includes('.blob.core.windows.net')) {
        assert.equal(init?.method, 'PUT');
        assert.ok(!JSON.stringify(init?.headers).includes('fixture-access-token'));
        assert.deepEqual(Buffer.from(init?.body as Uint8Array), png());
        return new Response('', { status: failUpload ? 403 : 201 });
      }
      if (url.endsWith('/image')) {
        widgets++;
        assert.equal(JSON.parse(String(init?.body)).name, 'icon.png');
        return Response.json({ value: { id: 'native-icon' } });
      }
      return Response.json({ value: { id: 'board' } });
    };
    assert.deepEqual(await exportMuralDiagram(pool, diagram), { boardUrl, objects: 1, connectors: 0 });
    failUpload = true;
    await assert.rejects(exportMuralDiagram(pool, diagram), /Icon upload failed.*Some objects may already exist/);
    assert.equal(widgets, 1);
    await assert.rejects(exportMuralDiagram(pool, { ...diagram, objects: [{ ...icon, image: 'data:image/png;base64,bm90IHBuZw==' }] }), /PNG/);
  } finally { globalThis.fetch = original; await db.close(); }
});

test('Native Mural creates areas before children, resolves real IDs, attaches arrows and escapes editable text', async () => {
  const { pool, db } = await fixture();
  const original = globalThis.fetch;
  try {
    await saveMuralConfig(pool, config);
    globalThis.fetch = async () => tokenResponse();
    await finishMuralAuth(pool, 'richard', { state: new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state'), code: 'fixture' });
    const calls: string[] = [];
    let shapeCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      if (!init?.body) return Response.json({ value: { id: 'board' } });
      const body: unknown = JSON.parse(String(init.body));
      if (url.endsWith('/area')) {
        assert.equal((body as Record<string, unknown>).showTitle, false);
        return Response.json({ value: { id: 'mural-area' } });
      }
      if (url.endsWith('/shape')) {
        const shape = (body as Array<Record<string, unknown>>)[0]!;
        assert.equal((shape.style as Record<string, unknown>).fontSize, 14);
        assert.equal((shape.style as Record<string, unknown>).textAlign, 'center');
        assert.equal((shape.style as Record<string, unknown>).font, 'proxima-nova');
        shapeCount++;
        if (shapeCount === 1) { assert.equal(shape.parentId, 'mural-area'); assert.equal(shape.x, 20); assert.equal(shape.y, 40); }
        return Response.json({ value: [{ id: shapeCount === 1 ? 'mural-child' : 'mural-target' }] });
      }
      if (url.endsWith('/textbox')) {
        const box = (body as Array<Record<string, unknown>>)[0]!;
        assert.ok(String(box.text).includes('&lt;script&gt;'));
        assert.ok(!String(box.text).includes('<script>'));
        assert.equal(box.parentId, 'mural-area');
        assert.equal(box.x, 10);
        assert.equal(box.y, 6);
        assert.equal(box.rotation, 270);
        assert.equal((box.style as Record<string, unknown>).backgroundColor, '#FFFFFF00');
        return Response.json({ value: [{ id: 'mural-text' }] });
      }
      if (url.endsWith('/arrow')) {
        const arrow = body as Record<string, unknown>;
        assert.equal(arrow.startRefId, 'mural-target'); assert.equal(arrow.endRefId, 'mural-child');
        assert.equal(arrow.tip, 'single'); assert.equal(arrow.arrowType, 'orthogonal');
        assert.deepEqual(arrow.points, [{ x: 520, y: 0 }, { x: 0, y: 0 }]);
        assert.ok(JSON.stringify(arrow.label).includes('Editable edge'));
        return Response.json({ value: { id: 'mural-arrow' } });
      }
      throw new Error(`Unexpected native write: ${url}`);
    };
    const diagram = nativeDiagram();
    Object.assign(diagram.objects[3]!, { parentId: 'area', x: 110, y: 106, rotation: 270, fill: '#FFFFFF00' });
    assert.deepEqual(await exportMuralDiagram(pool, diagram), { boardUrl, objects: 4, connectors: 1 });
    assert.ok(calls[1]!.endsWith('/area'));
    assert.equal(calls.filter(c => c.endsWith('/arrow')).length, 1);
    assert.ok(!calls.some(c => c.endsWith('/image')));
  } finally { globalThis.fetch = original; await db.close(); }
});

test('Native Mural rejects invalid exports before network access and reports partial writes without retries', async () => {
  const { pool, db } = await fixture(); const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Must not fetch'); };
    await assert.rejects(exportMuralDiagram(pool, { ...nativeDiagram(), objects: [] }));
    assert.equal(calls, 0);
    await saveMuralConfig(pool, config);
    globalThis.fetch = async () => tokenResponse();
    await finishMuralAuth(pool, 'richard', { state: new URL(await startMuralAuth(pool, 'richard')).searchParams.get('state'), code: 'fixture' });
    globalThis.fetch = async (input) => {
      calls++;
      if (String(input).endsWith('/area')) return Response.json({ value: { id: 'created-area' } });
      if (String(input).endsWith('/shape')) return new Response('', { status: 403 });
      return Response.json({ value: { id: 'board' } });
    };
    await assert.rejects(exportMuralDiagram(pool, nativeDiagram()), /Some objects may already exist.*Nothing was automatically retried/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; await db.close(); }
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
    assert.equal(url.searchParams.get('scope'), 'murals:read murals:write workspaces:read');
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
