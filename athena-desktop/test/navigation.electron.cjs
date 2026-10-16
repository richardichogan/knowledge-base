const assert = require('node:assert/strict');
const { once } = require('node:events');
const { app, BrowserWindow, session, shell } = require('electron');

const origin = 'https://athena.example.com';
const registration = 'https://mysignins.microsoft.com/api/post/registerSsprMethods';
const external = [];
const requests = [];
let timer;

shell.openExternal = async (url) => { external.push(url); };
process.env.ATHENA_URL = origin;

async function run() {
  assert.ok(process.env.ATHENA_NAVIGATION_PROFILE, 'Run through test/run-navigation.cjs');
  app.setPath('userData', process.env.ATHENA_NAVIGATION_PROFILE);
  await app.whenReady();
  await session.defaultSession.protocol.handle('https', async (request) => {
    requests.push({ url: request.url, method: request.method, body: await request.text() });
    return new Response('<!doctype html><title>Sign-in fixture</title>', {
      headers: { 'Content-Type': 'text/html' },
    });
  });
  const created = once(app, 'browser-window-created');
  require('../build/src/main.js');
  const [, main] = await created;
  if (main.webContents.isLoading() || main.webContents.getURL() !== `${origin}/`) {
    await once(main.webContents, 'did-finish-load');
  }
  const childCreated = once(main.webContents, 'did-create-window');
  await main.webContents.executeJavaScript(`window.open('about:blank', 'signin'); void 0;`);
  const [child] = await childCreated;
  if (child.webContents.isLoading()) await once(child.webContents, 'did-finish-load');
  const signIn = once(child.webContents, 'did-finish-load');
  await child.webContents.executeJavaScript(`location.href = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';`);
  await signIn;
  const submitted = once(child.webContents, 'did-finish-load');
  await child.webContents.executeJavaScript(`
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = ${JSON.stringify(registration)};
    const input = document.createElement('input');
    input.name = 'registration';
    input.value = 'preserve-this-body';
    form.append(input);
    document.body.append(form);
    form.submit();
  `);
  await submitted;
  const post = requests.find((request) => request.url === registration);
  assert.ok(post, 'Security registration must reach the Electron sign-in window');
  assert.equal(post.method, 'POST');
  assert.equal(post.body, 'registration=preserve-this-body');
  assert.deepEqual(external, [], 'Sign-in must not be handed off to the system browser');
  assert.equal(await child.webContents.executeJavaScript('typeof window.athenaDesktop'), 'undefined');
  const callback = once(child.webContents, 'did-finish-load');
  await child.webContents.executeJavaScript(`location.href = ${JSON.stringify(`${origin}/signin-callback`)};`);
  await callback;
  assert.equal(await child.webContents.executeJavaScript('window.opener !== null'), true);
  console.log('PASS: Microsoft registration preserves POST body, file isolation, and sign-in opener/callback');
}

timer = setTimeout(() => {
  console.error('FAIL: Electron navigation regression timed out');
  app.exit(1);
}, 30000);

run().then(() => {
  clearTimeout(timer);
  app.removeAllListeners('window-all-closed');
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
