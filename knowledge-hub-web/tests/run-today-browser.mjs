import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserPath = process.env.TODAY_BROWSER_PATH;
assert.ok(browserPath, 'Set TODAY_BROWSER_PATH to an installed Chromium browser executable');
const fixtureUrl = process.env.TODAY_FIXTURE_URL ?? 'http://localhost:5142/tests/today.html';
const profile = await mkdtemp(join(tmpdir(), 'athena-today-check-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
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
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Network.setBlockedURLs', { urls: ['*/api/*', '*/auth/*'] });
  for (const width of [1440, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await command('Page.navigate', { url: fixtureUrl });
    let ready = false;
    for (let i = 0; i < 300; i++) {
      ready = await evaluate('typeof window.runTodayChecks === "function" && document.querySelectorAll(".today-brief__attention article").length === 5');
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, `Fixture did not mount at ${width}px: ${browserErrors.join('\n') || await evaluate('document.body.innerText')}`);
    if (process.env.TODAY_ARTIFACT_DIR) {
      await mkdir(process.env.TODAY_ARTIFACT_DIR, { recursive: true });
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(process.env.TODAY_ARTIFACT_DIR, `today-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    const results = await evaluate('window.runTodayChecks()');
    console.log(JSON.stringify({ width, checks: results }, null, 2));
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) await command('Browser.close');
  socket?.close();
  browser.kill();
  await new Promise((resolve) => { if (browser.exitCode !== null) resolve(); else browser.once('exit', resolve); });
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
