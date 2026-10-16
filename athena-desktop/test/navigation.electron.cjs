const assert = require('node:assert/strict');
const { once } = require('node:events');
const { app, BrowserWindow, Menu, session, shell } = require('electron');

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
  const startedInChat = process.argv.includes('--chat');
  const initialUrl = startedInChat ? `${origin}/chat` : `${origin}/`;
  if (main.webContents.isLoading() || main.webContents.getURL() !== initialUrl) {
    await once(main.webContents, 'did-finish-load');
  }
  assert.equal(main.webContents.getURL(), initialUrl);
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
  child.destroy();

  const menu = Menu.getApplicationMenu();
  assert.ok(menu);
  const otherCreated = once(app, 'browser-window-created');
  menu.getMenuItemById(startedInChat ? 'open-workspace' : 'open-chat').click();
  const [, other] = await otherCreated;
  if (other.webContents.isLoading()) await once(other.webContents, 'did-finish-load');
  const chat = startedInChat ? main : other;
  const workspace = startedInChat ? other : main;
  assert.equal(chat.webContents.getURL(), `${origin}/chat`, 'Chat uses the same route as the PWA');
  assert.equal(workspace.webContents.getURL(), `${origin}/`);
  assert.equal(chat.isMenuBarVisible(), true);
  assert.equal(workspace.isMenuBarVisible(), true);
  assert.equal(await chat.webContents.executeJavaScript('typeof window.athenaDesktop.readText'), 'function');
  assert.equal(await workspace.webContents.executeJavaScript('typeof window.athenaDesktop.readText'), 'function');
  const chatDevice = await chat.webContents.executeJavaScript('window.athenaDesktop.device()');
  const workspaceDevice = await workspace.webContents.executeJavaScript('window.athenaDesktop.device()');
  assert.equal(chatDevice.deviceId, workspaceDevice.deviceId);
  await workspace.webContents.executeJavaScript(`localStorage.setItem('desktop-session-fixture', 'shared');`);
  assert.equal(await chat.webContents.executeJavaScript(`localStorage.getItem('desktop-session-fixture')`), 'shared');
  assert.equal(chat.webContents.session, workspace.webContents.session);
  await chat.webContents.executeJavaScript(`
    history.replaceState(null, '', '/chat?session=fixture');
    window.unsavedDraft = 'keep this draft';
  `);
  const chatId = chat.id;
  const workspaceId = workspace.id;
  app.emit('second-instance', {}, ['Athena.exe', '--chat']);
  app.emit('second-instance', {}, ['Athena.exe']);
  menu.getMenuItemById('open-chat').click();
  menu.getMenuItemById('open-workspace').click();
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'Repeated launches focus the existing windows');
  assert.equal(chat.id, chatId);
  assert.equal(workspace.id, workspaceId);
  assert.equal(chat.webContents.getURL(), `${origin}/chat?session=fixture`);
  assert.equal(await chat.webContents.executeJavaScript('window.unsavedDraft'), 'keep this draft');
  workspace.destroy();
  const reopened = once(app, 'browser-window-created');
  app.emit('second-instance', {}, ['Athena.exe']);
  const [, recreated] = await reopened;
  if (recreated.webContents.isLoading()) await once(recreated.webContents, 'did-finish-load');
  assert.equal(recreated.webContents.getURL(), `${origin}/`);
  assert.equal(await chat.webContents.executeJavaScript('window.unsavedDraft'), 'keep this draft');
  console.log(`PASS: ${startedInChat ? 'chat' : 'workspace'} launch, separate windows, menu/shortcut routing, shared desktop session/file access, and draft preservation`);
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
