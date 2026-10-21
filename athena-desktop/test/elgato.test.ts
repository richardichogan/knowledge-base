import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { ElgatoBridge } from '../src/elgatoBridge';
import { initialPresentation, parseCommand, playbackCommand } from '../src/elgatoProtocol';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

test('desktop commands reject stale, unknown and unbounded input', () => {
  const command = { id: 'test', command: 'new-note', issuedAt: Date.now() };
  assert.equal(parseCommand(command).command, 'new-note');
  assert.throws(() => parseCommand({ ...command, command: 'shell' }));
  assert.throws(() => parseCommand({ ...command, extra: 'file' }));
  assert.throws(() => parseCommand({ ...command, id: '' }));
  assert.throws(() => parseCommand({ ...command, issuedAt: Date.now() - 31_000 }));
  assert.throws(() => parseCommand({ ...command, issuedAt: NaN }));
});
test('manual transport changes actual speed, bounds font and resets explicitly', () => {
  const ready = { ...initialPresentation(), displayId: -1, sessionId: 'session', progress: 0.4 };
  assert.throws(() => playbackCommand(initialPresentation(), 'play'));
  let next = playbackCommand(ready, 'play');
  assert.equal(next.status, 'playing');
  next = playbackCommand(next, 'pause');
  assert.equal(next.progress, 0.4);
  assert.equal(next.status, 'paused');
  next = playbackCommand(next, 'faster');
  assert.equal(next.speed, 90);
  assert.equal(next.progress, 0.4);
  assert.equal(playbackCommand({ ...next, speed: 300 }, 'faster').speed, 300);
  assert.equal(playbackCommand({ ...next, speed: 10 }, 'slower').speed, 10);
  assert.equal(playbackCommand({ ...next, fontSize: 96 }, 'text-larger').fontSize, 96);
  assert.equal(playbackCommand({ ...next, fontSize: 24 }, 'text-smaller').fontSize, 24);
  assert.equal(playbackCommand(next, 'stop').progress, 0);
  assert.equal(playbackCommand({ ...next, status: 'ended', progress: 1 }, 'play').progress, 0);
});
test('output acknowledges commands, maintains fractional pace, pauses immediately and resets', async () => {
  let update: (value: unknown) => void = () => {};
  let tick: (time: number) => void = () => {};
  let top = 0;
  const viewport = {
    clientHeight: 100, scrollHeight: 1100,
    get scrollTop(): number { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(1000, Math.round(value))); },
  };
  const reports: { progress: number; ack?: number }[] = [];
  const script = { style: {}, textContent: '' };
  const context = createContext({
    window: { athenaOutput: {
      onUpdate: (fn: typeof update) => { update = fn; },
      report: (value: typeof reports[number]) => reports.push(value),
    } },
    document: { getElementById: (id: string) => id === 'viewport' ? viewport : script, body: { classList: { toggle: () => {} } } },
    requestAnimationFrame: (fn: typeof tick) => { tick = fn; },
  });
  runInContext(await readFile(join(__dirname, '../../assets/presentation.js'), 'utf8'), context);
  const state = { ...initialPresentation(), sessionId: 'one', displayId: 1, status: 'playing' };
  update({ state, text: '<img src=x onerror=alert(1)>', sequence: 1, reset: true });
  assert.equal(script.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(reports[0]?.ack, 1);
  for (let i = 0; i <= 60; i++) tick(i * (1000 / 60));
  assert.ok(Math.abs(top - 80) <= 1, `Expected 80px in one second, got ${top}`);
  update({ state: { ...state, status: 'paused' }, sequence: 2 });
  const paused = top;
  tick(1100); tick(1200);
  assert.equal(top, paused);
  update({ state: { ...state, status: 'ready', progress: 0 }, sequence: 3, reset: true });
  assert.equal(top, 0);
  update({ state: { ...state, speed: 300 }, sequence: 4 });
  for (let i = 0; i <= 600; i++) tick(1300 + i * (1000 / 60));
  assert.equal(top, 1000);
  assert.equal(reports.at(-1)?.progress, 1);
});
test('loopback bridge authenticates, rejects browser calls and deduplicates writes without replay', async () => {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  let writes = 0;
  const bridge = new ElgatoBridge(async () => { writes++; }, () => ({
    protocol: 1, presentation: initialPresentation(), recording: false, transcribing: false, error: null,
  }));
  const token = 'a'.repeat(64);
  await bridge.start(token, port);
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/state`)).status, 403);
    assert.equal((await fetch(`${base}/state`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/state`, { headers })).status, 200);
    const body = JSON.stringify({ id: 'same', command: 'new-note', issuedAt: Date.now() });
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body })).status, 200);
    assert.equal(writes, 1);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ id: 'x', command: 'shell', issuedAt: Date.now() }) })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: JSON.stringify({ id: 'x', command: 'new-note', issuedAt: Date.now() - 31_000 }) })).status, 400);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers, body: ' '.repeat(2049) })).status, 413);
    assert.equal(writes, 1);
  } finally { await bridge.stop(); }
  await assert.rejects(fetch(`${base}/state`, { headers }));
});

test('presentation IPC confirms scaled negative-coordinate displays, protects ownership and stops on unplug', async () => {
  class Contents extends EventEmitter {
    static next = 0;
    id = ++Contents.next;
    mainFrame = { url: 'https://athena.example/present' };
    messages: { channel: string; value: unknown }[] = [];
    send(channel: string, value: unknown): void {
      this.messages.push({ channel, value });
      if (channel === 'presentation:update') {
        const update = value as { sequence: number; state: { sessionId: string; progress: number } };
        ipc.emit('presentation:progress', event(this), { sessionId: update.state.sessionId, progress: update.state.progress, ack: update.sequence });
      } else if (channel === 'desktop:command') {
        ipc.emit('desktop:reply', event(this), { id: (value as { id: string }).id });
      }
    }
    setWindowOpenHandler(): void {}
  }
  class Window extends EventEmitter {
    static instances: Window[] = [];
    webContents = new Contents();
    destroyed = false;
    inactive = false;
    focused = false;
    constructor(public options: Record<string, unknown> = {}) { super(); Window.instances.push(this); }
    isDestroyed(): boolean { return this.destroyed; }
    show(): void {}
    focus(): void { this.focused = true; }
    showInactive(): void { this.inactive = true; }
    setBounds(bounds: unknown): void { this.options.bounds = bounds; }
    close(): void { this.destroyed = true; this.emit('closed'); }
    async loadFile(): Promise<void> {
      this.webContents.mainFrame.url = 'file:///presentation.html';
      ipc.emit('presentation:ready', event(this.webContents));
    }
    async loadURL(): Promise<void> {}
  }
  const event = (sender: Contents): { sender: Contents; senderFrame: { url: string } } => ({ sender, senderFrame: sender.mainFrame });
  const ipc = new EventEmitter();
  type IpcHandler = (source: ReturnType<typeof event>, value?: unknown) => Promise<unknown>;
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = Object.assign(ipc, { handle: (name: string, fn: IpcHandler): void => { handlers.set(name, fn); } });
  const displays = new EventEmitter();
  let available = [{ id: 42, label: 'Elgato Prom.', size: { width: 2560, height: 1440 },
    bounds: { x: -1707, y: 100, width: 1707, height: 960 }, scaleFactor: 1.5 }];
  let awake = 0;
  const app = Object.assign(new EventEmitter(), { getPath: () => 'fixture', getAppPath: () => 'fixture' });
  const electron = {
    BrowserWindow: Window, app, ipcMain,
    screen: Object.assign(displays, { getAllDisplays: () => available, getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 3440, height: 1440 } }) }),
    clipboard: { writeText: () => {} },
    safeStorage: { isEncryptionAvailable: () => true },
    powerSaveBlocker: { start: () => ++awake, stop: () => { awake--; } },
  };
  const realRequire = createRequire(join(__dirname, '../src/elgato.js'));
  const exported: { exports: unknown } = { exports: {} };
  const context = createContext({
    exports: exported.exports, module: exported, __dirname: join(__dirname, '../src'),
    require: (name: string): unknown => {
      if (name === 'electron') return electron;
      if (name === 'node:fs/promises') return {
        readFile: async () => { throw Object.assign(new Error('Not configured'), { code: 'ENOENT' }); },
        writeFile: async () => {}, rename: async () => {},
      };
      return realRequire(name);
    },
    console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  runInContext(await readFile(join(__dirname, '../src/elgato.js'), 'utf8'), context);
  const { installElgato } = exported.exports as {
    installElgato: (origin: string, create: (path: string) => Window, open: () => Window) => () => void;
  };
  const workspace = new Window();
  const setup = installElgato('https://athena.example', () => new Window(), () => workspace);
  setup();
  const controller = Window.instances.at(-1)!;
  async function invoke(name: string, value?: unknown, owner = controller): Promise<unknown> {
    const handler = handlers.get(name);
    assert.ok(handler);
    return handler(event(owner.webContents), value);
  }
  await assert.rejects(invoke('presentation:displays', undefined, workspace), /cannot control/);
  ipc.emit('desktop:ready', event(workspace.webContents));
  await invoke('presentation:command', { id: 'new-note', command: 'new-note', issuedAt: Date.now() });
  assert.ok(workspace.webContents.messages.some(message => message.channel === 'desktop:command'));
  const info = await invoke('presentation:displays') as { id: number; scale: number }[];
  assert.equal(info[0]?.id, 42);
  assert.equal(info[0]?.scale, 1.5);
  const script = { noteId: 'note-1', title: 'Script', text: 'Saved words', displayId: 42 };
  await invoke('presentation:start', script);
  const output = Window.instances.at(-1)!;
  assert.equal(output.options.x, -1707);
  assert.equal(output.options.width, 1707);
  assert.equal(output.options.focusable, false);
  assert.equal(output.inactive, true);
  assert.equal(output.focused, false);
  assert.match(String((output.options.webPreferences as { preload: string }).preload), /outputPreload/);
  await invoke('presentation:command', { id: 'play', command: 'play', issuedAt: Date.now() });
  assert.equal(awake, 1);
  const current = await invoke('presentation:state') as { presentation: { sessionId: string; progress: number; status: string; displayId: number | null } };
  ipc.emit('presentation:progress', event(output.webContents), { sessionId: 'stale', progress: 0.9 });
  assert.equal(current.presentation.progress, 0);
  ipc.emit('presentation:progress', event(output.webContents), { sessionId: current.presentation.sessionId, progress: 0.45 });
  const removed = available[0]!;
  available = [];
  displays.emit('display-removed', {}, removed);
  assert.equal(output.destroyed, true);
  assert.equal(awake, 0);
  const lost = await invoke('presentation:state') as typeof current;
  assert.equal(lost.presentation.status, 'disconnected');
  assert.equal(lost.presentation.displayId, null);
  assert.equal(lost.presentation.progress, 0.45);
  await assert.rejects(invoke('presentation:start', script), /available output/);
  available = [{ ...removed, id: 43 }];
  await invoke('presentation:start', { ...script, displayId: 43 });
  const resumed = await invoke('presentation:state') as typeof current;
  assert.equal(resumed.presentation.status, 'ready');
  assert.equal(resumed.presentation.progress, 0.45);
  assert.equal(awake, 0);
  await invoke('presentation:close');
});
