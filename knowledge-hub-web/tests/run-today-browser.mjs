import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserPath = process.env.TODAY_BROWSER_PATH;
assert.ok(browserPath, 'Set TODAY_BROWSER_PATH to an installed Chromium browser executable');
const fixtureUrl = process.env.TODAY_FIXTURE_URL ?? 'http://localhost:5142/tests/today.html';
const navigationChecks = process.env.ATHENA_BROWSER_CHECKS === 'navigation';
const discoverChecks = process.env.ATHENA_BROWSER_CHECKS === 'discover';
const thinkSearchChecks = process.env.ATHENA_BROWSER_CHECKS === 'think-search';
const connectionsChecks = process.env.ATHENA_BROWSER_CHECKS === 'connections';
const authSessionChecks = process.env.ATHENA_BROWSER_CHECKS === 'auth-session';
const noteCopyChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-copy';
const noteHistoryChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-history';
const authCallbackChecks = process.env.ATHENA_BROWSER_CHECKS === 'auth-callback';
const authLiveChecks = process.env.ATHENA_BROWSER_CHECKS === 'auth-live';
const imagineBriefChecks = process.env.ATHENA_BROWSER_CHECKS === 'imagine-brief';
const markdownExportChecks = process.env.ATHENA_BROWSER_CHECKS === 'markdown-export';
const profile = await mkdtemp(join(tmpdir(), 'athena-today-check-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  ...(authCallbackChecks || authLiveChecks ? ['--disable-popup-blocking'] : []),
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let socket;
let sequence = 0;
const browserErrors = [];
const pending = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Browser evaluation failed');
  return result.result.value;
}

try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(100); }
  }
  assert.ok(port, 'Browser did not start its isolated debugging endpoint');
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') {
      browserErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await command('Page.enable');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Network.setBlockedURLs', { urls: ['*/api/*', '*/auth/*'] });
  for (const width of navigationChecks ? [1440, 1024, 390] : [1440, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await command('Page.navigate', { url: fixtureUrl });
    let ready = false;
    for (let i = 0; i < 300; i++) {
      ready = await evaluate(navigationChecks
        ? 'typeof window.runNavigationChecks === "function" && document.querySelector(".kh-header__primary") !== null'
        : authLiveChecks ? 'document.querySelector(".pw-gate") !== null'
        : authCallbackChecks ? 'typeof window.runAuthCallbackChecks === "function"'
        : imagineBriefChecks ? 'typeof window.runImagineBriefChecks === "function" && document.querySelector("#compact-skill .ai-demo-brief-skill") !== null'
        : markdownExportChecks ? 'typeof window.runMarkdownExportChecks === "function" && document.querySelector(".notes-copy-btn") !== null'
        : discoverChecks ? 'typeof window.runDiscoverChecks === "function" && document.querySelector(".dc-action--linkedin") !== null'
        : connectionsChecks ? 'typeof window.runConnectionsChecks === "function" && document.querySelector(".conn-panel") !== null'
        : authSessionChecks ? 'typeof window.runAuthSessionChecks === "function" && document.querySelector("dialog") !== null'
        : noteHistoryChecks ? 'typeof window.runNoteHistoryChecks === "function" && document.querySelector(".notes-copy-btn") !== null'
        : noteCopyChecks ? 'typeof window.runNoteCopyChecks === "function" && document.querySelector(".notes-copy-btn") !== null'
        : thinkSearchChecks ? 'typeof window.runThinkSearchChecks === "function" && document.querySelector("#notes-search") !== null'
        : 'typeof window.runTodayChecks === "function" && document.querySelectorAll(".today-brief__attention article").length === 5');
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, `Fixture did not mount at ${width}px: ${browserErrors.join('\n') || await evaluate('document.body.innerText')}`);
    if (authLiveChecks) {
      const results = await evaluate(`(async () => {
        const originalUrl = location.href;
        const originalRoot = document.querySelector('.pw-gate');
        const draft = document.createElement('textarea');
        draft.value = 'Unsaved callback regression sentinel';
        document.body.append(draft);
        const waitFor = async (check) => {
          for (let i = 0; i < 300; i++) {
            if (check()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Live popup callback timeout');
        };
        for (const error of [false, true]) {
          const id = crypto.randomUUID();
          const state = btoa(JSON.stringify({ id, meta: { interactionType: 'popup' } }));
          const payload = new URLSearchParams({ state, ...(error
            ? { error: 'access_denied', error_description: 'Synthetic callback regression' }
            : { code: 'synthetic-not-a-real-auth-code' }) }).toString();
          const channel = new BroadcastChannel(id);
          let received = null;
          channel.onmessage = event => { received = event.data; };
          const popup = window.open('/signin#' + payload, 'athena-live-auth-check', 'width=400,height=500');
          if (!popup) throw new Error('Test popup blocked');
          try {
            await waitFor(() => received !== null);
            if (received.v !== 1 || received.payload !== payload) throw new Error('Callback payload not returned');
            await waitFor(() => popup.closed);
          } finally { if (!popup.closed) popup.close(); channel.close(); }
        }
        if (location.href !== originalUrl || document.querySelector('.pw-gate') !== originalRoot
          || !draft.isConnected || draft.value !== 'Unsaved callback regression sentinel') {
          throw new Error('Original page or unsaved state disturbed');
        }
        draft.remove();
        return ['deployed popup callback relays success/error', 'popup closes', 'original page remains mounted'];
      })()`);
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (thinkSearchChecks || connectionsChecks || authSessionChecks || noteCopyChecks || noteHistoryChecks || authCallbackChecks || imagineBriefChecks || markdownExportChecks) {
      const results = await evaluate(markdownExportChecks ? 'window.runMarkdownExportChecks()' : imagineBriefChecks ? 'window.runImagineBriefChecks()' : authCallbackChecks ? 'window.runAuthCallbackChecks()' : noteHistoryChecks ? 'window.runNoteHistoryChecks()' : noteCopyChecks ? 'window.runNoteCopyChecks()' : authSessionChecks ? 'window.runAuthSessionChecks()' : connectionsChecks ? 'window.runConnectionsChecks()' : 'window.runThinkSearchChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (discoverChecks) {
      const results = await evaluate('window.runDiscoverChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      const focusStayedInDialog = await evaluate('document.querySelector("dialog").contains(document.activeElement)');
      assert.ok(focusStayedInDialog, 'Modal owns focus');
      for (let i = 0; i < 6; i++) {
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        assert.ok(await evaluate('document.querySelector("dialog").contains(document.activeElement)'), 'Tab focus stays inside dialog');
      }
      if (process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `alert-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await delay(50);
      assert.equal(await evaluate('document.querySelector("dialog[open]") === null'), true, 'Escape dismisses alert');
      await evaluate('document.querySelector(".dc-action--linkedin").click()');
      await delay(100);
      assert.equal(await evaluate('document.querySelector("dialog[open]") !== null'), true);
      if (process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `discover-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
      console.log(JSON.stringify({ width, checks: [...results, 'Native Escape dismissal and keyboard focus trapping'] }, null, 2));
      continue;
    }
    if (navigationChecks) {
      const results = await evaluate('window.runNavigationChecks()');
      const recovery = await evaluate(`({
        sessionId: localStorage.getItem('kh-athena-session-id-standalone'),
        draft: sessionStorage.getItem('kh-athena-session-id-standalone-draft-' + localStorage.getItem('kh-athena-session-id-standalone'))
      })`);
      await command('Page.reload', { ignoreCache: true });
      let reloaded = false;
      for (let i = 0; i < 300; i++) {
        reloaded = await evaluate('typeof window.verifyChatReload === "function" && document.querySelector(".kh-header__primary") !== null');
        if (reloaded) break;
        await delay(100);
      }
      assert.ok(reloaded, 'Reload fixture did not mount');
      results.push(await evaluate(`window.verifyChatReload(${JSON.stringify(recovery)})`));
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      if (process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `navigation-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
      continue;
    }
    const todayStyle = await evaluate('window.readPageStyle()');
    const todayBody = await evaluate('window.readTypography(".today-brief__reason")');
    const todayNoteTitle = await evaluate('window.readTypography(".today-brief__continue h3")');
    const todayRefresh = await evaluate('window.readTypography(".today-brief__header .today-brief__quiet")');
    if (process.env.TODAY_ARTIFACT_DIR) {
      await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `today-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    const results = await evaluate('window.runTodayChecks()');
    console.log(JSON.stringify({ width, checks: results }, null, 2));
    for (const comparison of ['discover', 'think']) {
      await command('Page.navigate', { url: `${fixtureUrl}?compare=${comparison}` });
      let referenceStyle;
      for (let i = 0; i < 300; i++) {
        referenceStyle = await evaluate('typeof window.readPageStyle === "function" ? window.readPageStyle() : null');
        if (referenceStyle) break;
        await delay(100);
      }
      assert.ok(referenceStyle, `${comparison} page did not render`);
      assert.deepEqual(todayStyle, referenceStyle, `Today header must match the rendered ${comparison} page at ${width}px`);
      const referenceSelector = comparison === 'discover' ? '.dc-card-synopsis' : '.notes-list-item-title';
      let referenceTypography;
      for (let i = 0; i < 100; i++) {
        referenceTypography = await evaluate(`window.readTypography(${JSON.stringify(referenceSelector)})`);
        if (referenceTypography) break;
        await delay(100);
      }
      assert.ok(referenceTypography, `Missing ${comparison} content for typography comparison`);
      const todayTypography = comparison === 'discover' ? todayBody : todayNoteTitle;
      // Think's one-line list titles do not prescribe a line-height; Today wraps
      // titles intentionally. Family, size and weight still use the same style.
      const { lineHeight: referenceLineHeight, ...referenceType } = referenceTypography;
      const { lineHeight: todayLineHeight, ...todayType } = todayTypography;
      assert.deepEqual(todayType, referenceType, `Today content typography must match ${comparison}`);
      if (comparison === 'discover') assert.equal(todayLineHeight, referenceLineHeight);
      if (comparison === 'think') {
        const referenceButton = await evaluate('window.readTypography(".kb-import-btn")');
        assert.deepEqual(todayRefresh, referenceButton, 'Today Refresh must match Think Import typography');
      }
      if (process.env.TODAY_ARTIFACT_DIR) {
        const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `${comparison}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
      console.log(JSON.stringify({ width, comparedTo: comparison, exactHeaderMatch: referenceStyle }, null, 2));
    }
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) await command('Browser.close');
  socket?.close();
  browser.kill();
  await new Promise((resolve) => { if (browser.exitCode !== null) resolve(); else browser.once('exit', resolve); });
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
