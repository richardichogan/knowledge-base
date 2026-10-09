import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserPath = process.env.TODAY_BROWSER_PATH;
assert.ok(browserPath, 'Set TODAY_BROWSER_PATH to an installed Chromium browser executable');
const fixtureUrl = process.env.DIAGRAM_FIXTURE_URL ?? 'http://localhost:5142/tests/diagram.html';
const profile = await mkdtemp(join(tmpdir(), 'athena-diagram-check-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let socket;
let sequence = 0;
const pending = new Map();
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method} ${params.expression?.slice(0, 120) ?? ''}`)); }, 60_000);
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
async function nodePoint(label, fx, fy) {
  return evaluate(`(() => {
    const doc = window.diagramFixture.snapshot().document;
    const node = doc.nodes.find(n => n.label === ${JSON.stringify(label)});
    const rect = document.querySelector('svg.dg-canvas').getBoundingClientRect();
    return { x: rect.left + doc.viewport.x + (node.x + node.width * ${fx}) * doc.viewport.zoom,
      y: rect.top + doc.viewport.y + (node.y + node.height * ${fy}) * doc.viewport.zoom };
  })()`);
}
async function mouseClick(point) {
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function mouseDoubleClick(point) {
  await mouseClick(point);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 2 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 2 });
}
async function mouseDrag(from, to) {
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 5, y: from.y + (to.y - from.y) * i / 5, buttons: 1 });
  }
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
}
async function pointerChecks() {
  await evaluate('window.diagramFixture.clickButton("Fit diagram to view")');
  await evaluate('window.diagramFixture.waitFor(() => document.querySelector(".dg-status--saved") !== null)');
  const original = await evaluate('window.diagramFixture.snapshot().document');
  await mouseDoubleClick(await nodePoint('Workforce agents', 0.5, 0.5));
  await evaluate('window.diagramFixture.waitFor(() => document.querySelector(".dg-label-editor") !== null)');
  assert.equal(await evaluate('window.diagramFixture.snapshot().document.nodes.length'), original.nodes.length,
    'Double-click on a shape must edit its label, not create another object');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const panStart = await nodePoint('Workforce agents', 0.5, 0.5);
  await evaluate('document.querySelector(\'button[aria-label="Fit diagram to view"]\').focus()');
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...panStart });
  assert.equal(await evaluate(`document.elementFromPoint(${panStart.x}, ${panStart.y})?.closest(".dg-canvas") !== null`), true,
    'Pan test pointer must be over SVG canvas');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await evaluate('window.diagramFixture.waitFor(() => document.querySelector(".dg-sheet").classList.contains("dg-sheet--panning"))');
  await mouseDrag(panStart, { x: panStart.x + 60, y: panStart.y + 40 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await evaluate('window.diagramFixture.waitFor(() => document.querySelector(".dg-status--saved") !== null)');
  const panned = await evaluate('window.diagramFixture.snapshot().document');
  assert.equal(panned.viewport.x, original.viewport.x + 60, 'Space drag pans horizontally after toolbar focus');
  assert.equal(panned.viewport.y, original.viewport.y + 40, 'Space drag pans vertically');
  assert.deepEqual(panned.nodes, original.nodes, 'Panning over a shape does not move any shapes');
  assert.equal(await evaluate('document.querySelector(".dg-sheet").classList.contains("dg-sheet--panning")'), false);
  await evaluate('document.querySelector(\'input[aria-label="Diagram title"]\').focus()');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  assert.equal(await evaluate('document.querySelector(".dg-sheet").classList.contains("dg-sheet--panning")'), false,
    'Typing spaces never activates panning');
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await evaluate('document.querySelector(\'input[aria-label="Diagram title"]\').blur(); window.diagramFixture.clickButton("Fit diagram to view")');
  await evaluate('window.diagramFixture.waitFor(() => document.querySelector(".dg-status--saved") !== null)');
  const host = original.nodes.find(n => n.label === 'Experience');
  const child = original.nodes.find(n => n.label === 'Teams / Copilot');
  const from = await nodePoint('Experience', 0.1, 0.95);
  const offset = 40 * original.viewport.zoom;
  await mouseDrag(from, { x: from.x + offset, y: from.y + offset });
  await evaluate(`window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.nodes.find(n => n.id === "${host.id}").x !== ${host.x})`);
  const moved = await evaluate('window.diagramFixture.snapshot().document');
  const movedHost = moved.nodes.find(n => n.id === host.id);
  const movedChild = moved.nodes.find(n => n.id === child.id);
  assert.equal(movedChild.x - child.x, movedHost.x - host.x, 'Moving a nested container must translate its child');
  assert.equal(movedChild.y - child.y, movedHost.y - host.y, 'Moving a nested container must translate its child vertically');
  await mouseClick(await nodePoint('Workforce agents', 0.5, 0.5));
  const source = await evaluate(`(() => {
    const n = window.diagramFixture.snapshot().document.nodes.find(n => n.label === "Workforce agents");
    const rect = document.querySelector('[data-dg="port"][data-id="' + n.id + '"][data-port="right"]').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouseDrag(source, await nodePoint('Agentic Service Bus', 0.5, 0.01));
  await evaluate(`window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.edges.length === ${original.edges.length + 1})`);
  const linked = await evaluate('window.diagramFixture.snapshot().document');
  const edge = linked.edges.at(-1);
  assert.equal(edge.sourceId, linked.nodes.find(n => n.label === 'Workforce agents').id);
  assert.equal(edge.targetId, linked.nodes.find(n => n.label === 'Agentic Service Bus').id);
  await mouseClick(await nodePoint('Workforce agents', 0.5, 0.5));
  const handle = await evaluate(`(() => {
    const n = window.diagramFixture.snapshot().document.nodes.find(n => n.label === "Workforce agents");
    const rect = document.querySelector('[data-dg="resize"][data-id="' + n.id + '"][data-handle="se"]').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouseDrag(handle, { x: handle.x + 20, y: handle.y + 10 });
  const workforce = linked.nodes.find(n => n.label === 'Workforce agents');
  await evaluate(`window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.nodes.find(n => n.id === "${workforce.id}").width > ${workforce.width})`);
  const beforeLine = await evaluate('window.diagramFixture.snapshot().document');
  await evaluate('window.diagramFixture.clickButton("Draw line")');
  const lineStart = await nodePoint('Workforce agents', 0.25, 0.5);
  await mouseDrag(lineStart, { x: lineStart.x + 100, y: lineStart.y + 60 });
  await evaluate('window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.nodes.some(n => n.kind === "line"))');
  const withLine = await evaluate('window.diagramFixture.snapshot().document');
  const plainLine = withLine.nodes.find(n => n.kind === 'line');
  await evaluate(`document.querySelector('[aria-label="Line style"] button[aria-label="Dotted"]').click();
    const field = document.querySelector('select[aria-label="Line thickness"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(field, "4");
    field.dispatchEvent(new Event("change", { bubbles: true }));`);
  await evaluate(`window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.nodes.some(n => n.id === "${plainLine.id}" && n.strokeStyle === "dotted" && n.strokeWidth === 4))`);
  assert.equal(withLine.edges.length, beforeLine.edges.length, 'Plain lines do not add connectors');
  assert.equal(await evaluate(`document.querySelector('g[data-id="${plainLine.id}"] line.dg-node__body').hasAttribute("marker-end")`), false);
  assert.equal(await evaluate(`document.querySelector('[data-dg="port"][data-id="${plainLine.id}"]') === null`), true);
  const endpoint = await evaluate(`(() => {
    const r = document.querySelector('[data-dg="line-end"][data-id="${plainLine.id}"][data-end="1"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await mouseDrag(endpoint, { x: endpoint.x + 40, y: endpoint.y - 30 });
  await evaluate(`window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.nodes.find(n => n.id === "${plainLine.id}").width !== ${plainLine.width})`);
  await evaluate('window.diagramFixture.clickButton("Undo (Ctrl+Z)")');
  await evaluate(`window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.nodes.find(n => n.id === "${plainLine.id}").width === ${plainLine.width})`);
  await evaluate('window.diagramFixture.clickButton("Redo (Ctrl+Shift+Z)")');
  await evaluate(`window.diagramFixture.waitFor(() => window.diagramFixture.snapshot().document.nodes.find(n => n.id === "${plainLine.id}").width !== ${plainLine.width})`);
  await evaluate('window.diagramFixture.clickButton("Draw line")');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evaluate('window.diagramFixture.waitFor(() => document.querySelector(\'button[aria-label="Draw line"]\').getAttribute("aria-pressed") === "false")');
  await evaluate('window.diagramFixture.clickButton("Delete (Del)")');
  await evaluate(`window.diagramFixture.waitFor(() => !window.diagramFixture.snapshot().document.nodes.some(n => n.id === "${plainLine.id}"))`);
  return ['Space drag pans after toolbar focus without moving shapes or intercepting text spaces',
    'Pointer drag translates nested children', 'Port drag creates a shape-attached connector', 'Resize handle updates saved geometry',
    'Standalone line drag drawing, endpoint editing, undo/redo and Escape cancellation'];
}
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(100); }
  }
  assert.ok(port, 'Browser did not start');
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Network.setBlockedURLs', { urls: ['*/api/*', '*/auth/*'] });
  for (const width of [1440, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
    await command('Runtime.evaluate', { expression: 'delete window.runDiagramChecks' });
    await command('Page.navigate', { url: fixtureUrl });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      ready = await evaluate('typeof window.runDiagramChecks === "function" && document.querySelector(".dg-editor") !== null');
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, `Diagram fixture did not mount: ${errors.join('\n') || await evaluate('document.body.innerText')}`);
    if (process.env.DIAGRAM_ARTIFACT_DIR) {
      await evaluate(`document.querySelector('g.dg-edge').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))`);
      await evaluate('window.diagramFixture.waitFor(() => document.querySelector(".dg-properties__kind")?.textContent === "Connector")');
      await mkdir(process.env.DIAGRAM_ARTIFACT_DIR, { recursive: true });
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(process.env.DIAGRAM_ARTIFACT_DIR, `diagram-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    const pointer = width === 1440 ? await pointerChecks() : [];
    console.log(JSON.stringify({ width, checks: [...pointer, ...await evaluate('window.runDiagramChecks()')] }, null, 2));
  }
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (err) {
  console.error(await evaluate('document.body.innerText').catch(() => 'Unable to read fixture state'));
  if (errors.length > 0) console.error(errors.join('\n'));
  throw err;
} finally {
  if (socket?.readyState === WebSocket.OPEN) await command('Browser.close');
  socket?.close(); browser.kill();
  await new Promise((resolve) => { if (browser.exitCode !== null) resolve(); else browser.once('exit', resolve); });
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
