import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserWidths } from '../../scripts/browser-viewports.mjs';

const browserPath = process.env.TODAY_BROWSER_PATH;
assert.ok(browserPath, 'Set TODAY_BROWSER_PATH to an installed Chromium browser executable');
const fixtureUrl = process.env.TODAY_FIXTURE_URL ?? 'http://localhost:5142/tests/today.html';
const navigationChecks = process.env.ATHENA_BROWSER_CHECKS === 'navigation';
const chatChecks = process.env.ATHENA_BROWSER_CHECKS === 'chat';
const projectPickerChecks = process.env.ATHENA_BROWSER_CHECKS === 'project-pickers';
const watchlistProjectChecks = process.env.ATHENA_BROWSER_CHECKS === 'watchlist-projects';
const discoverChecks = process.env.ATHENA_BROWSER_CHECKS === 'discover';
const sparkChecks = process.env.ATHENA_BROWSER_CHECKS === 'sparks';
const podcastPrepChecks = process.env.ATHENA_BROWSER_CHECKS === 'podcast-prep';
const thinkSearchChecks = process.env.ATHENA_BROWSER_CHECKS === 'think-search';
const connectionsChecks = process.env.ATHENA_BROWSER_CHECKS === 'connections';
const muralChecks = process.env.ATHENA_BROWSER_CHECKS === 'mural';
const panelTypographyChecks = process.env.ATHENA_BROWSER_CHECKS === 'panel-typography';
const authSessionChecks = process.env.ATHENA_BROWSER_CHECKS === 'auth-session';
const noteCopyChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-copy';
const noteHistoryChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-history';
const notePopoutChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-popout';
const noteRecoveryChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-recovery';
const authCallbackChecks = process.env.ATHENA_BROWSER_CHECKS === 'auth-callback';
const authLiveChecks = process.env.ATHENA_BROWSER_CHECKS === 'auth-live';
const imagineBriefChecks = process.env.ATHENA_BROWSER_CHECKS === 'imagine-brief';
const markdownExportChecks = process.env.ATHENA_BROWSER_CHECKS === 'markdown-export';
const thinkSaveChecks = process.env.ATHENA_BROWSER_CHECKS === 'think-save';
const noteGitHubChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-github';
const diagramThemeChecks = process.env.ATHENA_BROWSER_CHECKS === 'diagram-theme';
const noteLinksChecks = process.env.ATHENA_BROWSER_CHECKS === 'note-links';
const watchlistChecks = process.env.ATHENA_BROWSER_CHECKS === 'watchlists';
const shareEmailChecks = process.env.ATHENA_BROWSER_CHECKS === 'share-email';
const profile = await mkdtemp(join(tmpdir(), 'athena-today-check-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  // Never touch the macOS Keychain, which otherwise prompts for his password.
  '--use-mock-keychain', '--password-store=basic',
  ...(authCallbackChecks || authLiveChecks || notePopoutChecks ? ['--disable-popup-blocking'] : []),
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserStartupError;
let browserStderr = '';
browser.on('error', error => { browserStartupError = error; });
browser.stderr.on('data', chunk => { browserStderr = (browserStderr + chunk.toString()).slice(-8000); });
let socket;
let sequence = 0;
const browserErrors = [];
const loadDiagnostics = [];
const resourceUrls = new Map();
const pending = new Map();
let interceptedDrag = null;
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
async function retryAbortedMount(attempt) {
  if (attempt !== 299 || browserErrors.length > 0
    || !loadDiagnostics.some(entry => /\/src\/.+\.tsx?: net::ERR_ABORTED$/.test(entry))
    || await evaluate('document.body.innerText.trim() !== ""')) return;
  console.warn('Retrying blank fixture mount once after an aborted source-module request; application errors and checks are never retried.');
  await command('Page.reload', { ignoreCache: true });
}

try {
  let port;
  for (let i = 0; i < 300; i++) {
    if (browserStartupError) throw browserStartupError;
    if (browser.exitCode !== null || browser.signalCode !== null) {
      throw new Error(`Browser exited before readiness (${browser.exitCode ?? browser.signalCode}): ${browserStderr}`);
    }
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(100); }
  }
  assert.ok(port, `Browser did not start its isolated debugging endpoint within 30s: ${browserStderr}`);
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Input.dragIntercepted') interceptedDrag = message.params.data;
    if (message.method === 'Runtime.exceptionThrown') {
      const description = message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text;
      if (!(navigationChecks && /^Error: Fixture deferred view unavailable(?:\n|$)/.test(description))) browserErrors.push(description);
    }
    if (message.method === 'Network.requestWillBeSent') {
      resourceUrls.set(message.params.requestId, message.params.request.url);
    }
    if (message.method === 'Network.loadingFailed' && !message.params.blockedReason) {
      loadDiagnostics.push(`${resourceUrls.get(message.params.requestId)}: ${message.params.errorText}`);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      loadDiagnostics.push(`${message.params.entry.url ?? ''}: ${message.params.entry.text}`);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await command('Page.enable');
  await command('Page.bringToFront');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Log.enable');
  await command('Network.setBlockedURLs', { urls: ['*/api/*', '*/auth/*'] });
  for (const width of browserWidths(process.env.ATHENA_BROWSER_CHECKS)) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await command('Page.navigate', { url: fixtureUrl });
    let ready = false;
    for (let i = 0; i < 600; i++) {
      ready = await evaluate(shareEmailChecks ? 'typeof window.runShareEmailChecks === "function"'
        : navigationChecks
        ? 'typeof window.runNavigationChecks === "function" && document.querySelector(".kh-header__primary") !== null'
        : chatChecks ? 'typeof window.runChatChecks === "function" && document.querySelector("#navigation-probe") !== null'
        : projectPickerChecks ? 'typeof window.runProjectPickerChecks === "function" && document.querySelector(".kh-header__primary") !== null'
        : watchlistProjectChecks ? 'typeof window.runWatchlistProjectChecks === "function"'
        : noteLinksChecks ? 'typeof window.runNoteLinkChecks === "function" && document.querySelector(".notes-editor-scroll") !== null'
        : watchlistChecks ? 'typeof window.runWatchlistChecks === "function"'
        : diagramThemeChecks ? 'typeof window.runDiagramThemeChecks === "function" && document.querySelector(".dg-node__body") !== null'
        : noteGitHubChecks ? 'typeof window.runNoteGitHubChecks === "function" && document.querySelector(".notes-export-anchor > button") !== null'
        : thinkSaveChecks ? 'typeof window.runThinkSaveChecks === "function" && document.querySelector(".ai-move__button") !== null'
        : authLiveChecks ? 'document.querySelector(".pw-gate") !== null'
        : authCallbackChecks ? 'typeof window.runAuthCallbackChecks === "function"'
        : imagineBriefChecks ? 'typeof window.runImagineBriefChecks === "function" && document.querySelector("#compact-skill .ai-demo-brief-skill") !== null'
        : markdownExportChecks ? 'typeof window.runMarkdownExportChecks === "function" && document.querySelector(".notes-export-anchor > button") !== null'
        : discoverChecks ? 'typeof window.runDiscoverChecks === "function" && document.querySelector(".dc-card .dc-action--explore") !== null'
        : sparkChecks ? 'typeof window.runSparkChecks === "function" && document.querySelector(".spark-item__drag") !== null'
        : podcastPrepChecks ? 'typeof window.runPodcastPrepChecks === "function" && document.querySelector(".podcast-prep-notification") !== null'
        : panelTypographyChecks ? 'typeof window.runPanelTypographyChecks === "function" && document.querySelector(".panel-review") !== null'
        : muralChecks ? 'typeof window.runDiagramMuralChecks === "function"'
        : connectionsChecks ? 'typeof window.runConnectionsChecks === "function" && document.querySelector(".conn-panel") !== null'
        : authSessionChecks ? 'typeof window.runAuthSessionChecks === "function" && document.querySelector("dialog") !== null'
        : notePopoutChecks ? 'typeof window.runNotePopoutChecks === "function" && document.querySelector(".notes-popout-btn") !== null'
        : noteHistoryChecks ? 'typeof window.runNoteHistoryChecks === "function" && document.querySelector(".notes-export-anchor > button") !== null'
        : noteRecoveryChecks ? 'typeof window.runNoteRecoveryChecks === "function" && document.querySelector(".notes-export-anchor > button") !== null'
        : noteCopyChecks ? 'typeof window.runNoteCopyChecks === "function" && document.querySelector(".notes-copy-btn") !== null'
        : thinkSearchChecks ? 'typeof window.runThinkSearchChecks === "function" && document.querySelector("#notes-search") !== null'
        : 'typeof window.runTodayChecks === "function" && document.querySelectorAll(".today-brief__attention article").length === 5');
      if (ready) break;
      await retryAbortedMount(i);
      await delay(100);
    }
    assert.ok(ready, `Fixture did not mount at ${width}px: ${browserErrors.join('\n') || await evaluate('JSON.stringify({ url: location.href, readyState: document.readyState, text: document.body.innerText })')}\n${loadDiagnostics.join('\n')}`);
    if (shareEmailChecks) {
      const results = await evaluate('window.runShareEmailChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (panelTypographyChecks) {
      const results = await evaluate('window.runPanelTypographyChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      if (process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        await command('Page.bringToFront');
        const screenshot = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `panels-${width}.png`), Buffer.from(screenshot.data, 'base64'));
        await evaluate('document.querySelector(".dc-explore__close").click()');
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const metrics = await command('Page.getLayoutMetrics');
        const gallery = await command('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 },
        });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `panel-gallery-${width}.png`), Buffer.from(gallery.data, 'base64'));
      }
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (projectPickerChecks || watchlistProjectChecks) {
      const results = await evaluate(projectPickerChecks ? 'window.runProjectPickerChecks()' : 'window.runWatchlistProjectChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (noteLinksChecks || watchlistChecks) {
      const results = await evaluate(noteLinksChecks ? 'window.runNoteLinkChecks()' : 'window.runWatchlistChecks()');
      if (watchlistChecks && process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        await evaluate('window.prepareWatchlistReview()');
        for (const [name, selector] of [['briefing', '.dw-intelligence'], ['impact', '.dw-project-insights']]) {
          await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"start"})`);
          await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          await command('Page.bringToFront');
          const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `intelligence-${name}-${width}.png`), Buffer.from(image.data, 'base64'));
        }
      }
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (noteRecoveryChecks) {
      if (process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        await evaluate('window.prepareNoteRecoveryComparison()');
        const comparison = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `recovery-comparison-${width}.png`), Buffer.from(comparison.data, 'base64'));
      }
      const before = await evaluate('window.runNoteRecoveryChecks()');
      await evaluate('window.recoveryReloadMarker = true');
      await command('Page.reload', { ignoreCache: true });
      let reloaded = false;
      for (let attempt = 0; attempt < 600; attempt++) {
        reloaded = await evaluate('window.recoveryReloadMarker !== true && typeof window.runNoteRecoveryReloadChecks === "function" && document.querySelector(".notes-export-anchor > button") !== null');
        if (reloaded) break;
        await delay(100);
      }
      assert.ok(reloaded, 'Recovery fixture reload did not mount');
      const after = await evaluate('window.runNoteRecoveryReloadChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      if (process.env.TODAY_ARTIFACT_DIR) {
        await evaluate('window.recoveryReloadMarker = true');
        await command('Page.reload', { ignoreCache: true });
        let captureReady = false;
        for (let attempt = 0; attempt < 600; attempt++) {
          captureReady = await evaluate('window.recoveryReloadMarker !== true && typeof window.prepareNoteRecoveryCentre === "function" && document.querySelector(".notes-export-anchor > button") !== null');
          if (captureReady) break;
          await delay(100);
        }
        assert.ok(captureReady, `Recovery capture did not mount: ${browserErrors.join('\n') || await evaluate('JSON.stringify({ url: location.href, text: document.body.innerText })')}`);
        await evaluate('window.prepareNoteRecoveryCentre()');
        const centre = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `recovery-centre-${width}.png`), Buffer.from(centre.data, 'base64'));
      }
      console.log(JSON.stringify({ width, checks: [...before, ...after] }, null, 2));
      continue;
    }
    if (diagramThemeChecks) {
      const results = await evaluate('window.runDiagramThemeChecks()');
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (noteGitHubChecks) {
      const results = await evaluate('window.runNoteGitHubChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (authLiveChecks) {
      const results = await evaluate(`(async () => {
        const originalUrl = location.href;
        const originalRoot = document.querySelector('.pw-gate');
        const draft = document.createElement('textarea');
        draft.value = 'Unsaved callback regression sentinel';
        document.body.append(draft);
        const waitFor = async (check) => {
          for (let i = 0; i < 600; i++) {
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
    if (podcastPrepChecks) {
      const results = await evaluate('window.runPodcastPrepChecks()');
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (muralChecks || sparkChecks || thinkSaveChecks || thinkSearchChecks || connectionsChecks || authSessionChecks || noteCopyChecks || noteHistoryChecks || notePopoutChecks || authCallbackChecks || imagineBriefChecks || markdownExportChecks) {
      if (sparkChecks && process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        await evaluate('window.prepareSparkDrag()');
        await command('Page.bringToFront');
        const image = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `sparks-drag-${width}.png`), Buffer.from(image.data, 'base64'));
        await evaluate('window.cancelSparkDrag()');
      }
      const results = await evaluate(muralChecks ? 'window.runDiagramMuralChecks()' : sparkChecks ? 'window.runSparkChecks()' : notePopoutChecks ? 'window.runNotePopoutChecks()' : thinkSaveChecks ? 'window.runThinkSaveChecks()' : markdownExportChecks ? 'window.runMarkdownExportChecks()' : imagineBriefChecks ? 'window.runImagineBriefChecks()' : authCallbackChecks ? 'window.runAuthCallbackChecks()' : noteHistoryChecks ? 'window.runNoteHistoryChecks()' : noteCopyChecks ? 'window.runNoteCopyChecks()' : authSessionChecks ? 'window.runAuthSessionChecks()' : connectionsChecks ? 'window.runConnectionsChecks()' : 'window.runThinkSearchChecks()');
      if (muralChecks && process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        const image = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `mural-export-${width}.png`), Buffer.from(image.data, 'base64'));
      }
      if (sparkChecks && width !== 390) {
        for (const source of ['.spark-item__drag', '.spark-panel__loose .spark-item__body']) {
          await evaluate('window.resetNativeSparkDrag()');
          await evaluate(`document.querySelector(${JSON.stringify(source)}).scrollIntoView({block:"center"})`);
          const start = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(source)}).getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+r.height/2 }; })()`);
          interceptedDrag = null;
          await command('Input.setInterceptDrags', { enabled: true });
          await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
          await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
          for (let step = 1; step <= 5; step++) {
            await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + step * 3, y: start.y - step * 5, button: 'left', buttons: 1 });
          }
          for (let attempt = 0; attempt < 20 && !interceptedDrag; attempt++) await delay(50);
          assert.ok(interceptedDrag, `Real mouse gesture did not start a Spark drag from ${source}`);
          await evaluate('document.querySelector(".spark-theme").scrollIntoView({block:"center"})');
          const end = await evaluate('(() => { const r = document.querySelector(".spark-theme__name").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
          for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await command('Input.dispatchDragEvent', { type, ...end, data: interceptedDrag });
          }
          await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
          await command('Input.setInterceptDrags', { enabled: false });
          await evaluate('window.verifyNativeSparkDrag()');
          results.push(`Real browser mouse drag from ${source} persisted membership`);
        }
      }
      if (sparkChecks && process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        await command('Page.bringToFront');
        const image = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `sparks-${width}.png`), Buffer.from(image.data, 'base64'));
      }
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      if (notePopoutChecks && process.env.TODAY_ARTIFACT_DIR) {
        await command('Page.navigate', { url: `${fixtureUrl}?reader=1` });
        let mounted = false;
        for (let attempt = 0; attempt < 300; attempt++) {
          mounted = await evaluate('document.querySelector(".note-popout .bn-editor") !== null');
          if (mounted) break;
          await delay(100);
        }
        assert.ok(mounted, 'Pop-out screenshot did not mount');
        await command('Page.bringToFront');
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        const image = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `note-popout-${width}.png`), Buffer.from(image.data, 'base64'));
      }
      console.log(JSON.stringify({ width, checks: results }, null, 2));
      continue;
    }
    if (discoverChecks) {
      if (process.env.TODAY_ARTIFACT_DIR) {
        await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
        const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `discover-card-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
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
      await evaluate('document.querySelector(".dc-card .dc-action--explore").click()');
      await delay(100);
      await evaluate('[...document.querySelectorAll(".dc-explore__action")].find((b) => b.textContent.includes("Social post")).click()');
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
    if (navigationChecks || chatChecks) {
      const results = await evaluate(chatChecks ? 'window.runChatChecks()' : 'window.runNavigationChecks()');
      const recovery = await evaluate(`({
        sessionId: localStorage.getItem('kh-athena-session-id-standalone'),
        draft: sessionStorage.getItem('kh-athena-session-id-standalone-draft-' + localStorage.getItem('kh-athena-session-id-standalone'))
      })`);
      await command('Page.reload', { ignoreCache: true });
      let reloaded = false;
      for (let i = 0; i < 300; i++) {
        reloaded = await evaluate(chatChecks
          ? 'typeof window.verifyChatReload === "function" && document.querySelector("#navigation-probe") !== null'
          : 'typeof window.verifyChatReload === "function" && document.querySelector(".kh-header__primary") !== null');
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
        await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `${chatChecks ? 'chat' : 'navigation'}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
        if (navigationChecks) {
          await evaluate('window.showGraphReview()');
          const graphScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `graph-${width}.png`), Buffer.from(graphScreenshot.data, 'base64'));
          await evaluate('document.querySelector(\'[aria-label="Search"]\').click()');
          await delay(100);
          const paletteScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `palette-${width}.png`), Buffer.from(paletteScreenshot.data, 'base64'));
        }
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
      for (let i = 0; i < 600; i++) {
        referenceStyle = await evaluate('typeof window.readPageStyle === "function" ? window.readPageStyle() : null');
        if (referenceStyle) break;
        await retryAbortedMount(i);
        await delay(100);
      }
      assert.ok(referenceStyle, `${comparison} page did not render: ${browserErrors.join('\n') || await evaluate('JSON.stringify({ url: location.href, readyState: document.readyState, text: document.body.innerText })')}\n${loadDiagnostics.join('\n')}`);
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
      // Discover is a larger reading surface by design, so only family and weight are shared.
      const { lineHeight: _referenceLineHeight, ...referenceType } = referenceTypography;
      const { lineHeight: _todayLineHeight, ...todayType } = todayTypography;
      if (comparison === 'discover') {
        assert.deepEqual({ fontFamily: todayType.fontFamily, fontWeight: todayType.fontWeight },
          { fontFamily: referenceType.fontFamily, fontWeight: referenceType.fontWeight }, 'Today content typography must match discover family and weight');
      } else {
        assert.deepEqual(todayType, referenceType, `Today content typography must match ${comparison}`);
      }
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
} catch (error) {
  if (process.env.TODAY_ARTIFACT_DIR && socket?.readyState === WebSocket.OPEN) {
    try {
      await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
      await command('Page.bringToFront');
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(process.env.TODAY_ARTIFACT_DIR, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
      await writeFile(join(process.env.TODAY_ARTIFACT_DIR, 'failure.json'),
        JSON.stringify({ fixtureUrl, error: String(error), browserErrors, loadDiagnostics }, null, 2));
    } catch (captureError) {
      console.error('Could not capture browser failure diagnostics:', captureError);
    }
  }
  throw error;
} finally {
  socket?.close();
  browser.kill();
  await new Promise((resolve) => {
    if (browser.exitCode !== null || browser.signalCode !== null || browserStartupError) resolve();
    else browser.once('exit', resolve);
  });
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
