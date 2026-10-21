import { BrowserWindow, app, clipboard, ipcMain, powerSaveBlocker, safeStorage, screen, type IpcMainInvokeEvent } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ElgatoBridge } from './elgatoBridge';
import { initialPresentation, parseCommand, playbackCommand, type CommandRequest, type DesktopCommandState, type PresentationScript } from './elgatoProtocol';
import { isAthenaFrame } from './navigation';
import { wakePresentationDisplay } from './displayWake';

interface Config { encryptedToken?: string; display?: string; noteId?: string; settings?: { speed: number; fontSize: number; mirror: boolean; flip: boolean; opacity: number } }
type Reply = { id: string; error?: string };
export function installElgato(
  origin: string,
  createController: (path: string) => BrowserWindow,
  open: (mode: 'workspace' | 'chat') => BrowserWindow,
): () => void {
  let controller: BrowserWindow | null = null;
  let output: BrowserWindow | null = null;
  let outputReady = false;
  let outputOwner: number | null = null;
  let starting = false;
  let script: PresentationScript | null = null;
  let state: DesktopCommandState = { protocol: 1, presentation: initialPresentation(), recording: false, transcribing: false, error: null };
  let config: Config = {};
  let configLoaded: Promise<void> = Promise.resolve();
  let token = '';
  let bridgeError: string | null = null;
  let awake: number | null = null;
  let sequence = 0;
  let voiceOwner: number | null = null;
  const ready = new Set<number>();
  const pending = new Map<string, { sender: number; resolve: () => void; reject: (error: Error) => void }>();
  const outputAcks = new Map<number, () => void>();
  const configPath = join(app.getPath('userData'), 'elgato.json');
  const fingerprint = (display: Electron.Display): string =>
    `${display.label}:${display.size.width}x${display.size.height}:${display.scaleFactor}`;
  let saving: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const snapshot = JSON.stringify(config);
    const next = saving.then(async () => {
      await writeFile(`${configPath}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${configPath}.tmp`, configPath);
    });
    // The caller surfaces failures; a failed write must not block later retries.
    saving = next.catch(() => {});
    return next;
  };
  const saveSettings = async (): Promise<void> => {
    const { speed, fontSize, mirror, flip, opacity } = state.presentation;
    config.settings = { speed, fontSize, mirror, flip, opacity };
    await persist();
  };
  const syncAwake = (): void => {
    if (state.presentation.status === 'playing' && awake === null) awake = powerSaveBlocker.start('prevent-display-sleep');
    else if (state.presentation.status !== 'playing' && awake !== null) { powerSaveBlocker.stop(awake); awake = null; }
  };
  const publish = (): void => {
    syncAwake();
    if (controller && !controller.isDestroyed()) controller.webContents.send('presentation:state', state);
  };
  const disconnected = (message: string): void => {
    outputReady = false;
    state.presentation = { ...state.presentation, displayId: null, status: 'disconnected', error: message };
    publish();
  };
  const sendOutput = async (reset = false, includeText = false): Promise<void> => {
    if (!output || !outputReady) throw new Error('The presentation display is not ready.');
    const seq = ++sequence;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { outputAcks.delete(seq); reject(new Error('Presentation display did not acknowledge the command.')); }, 3000);
        outputAcks.set(seq, () => { clearTimeout(timer); resolve(); });
        output?.webContents.send('presentation:update', {
          state: state.presentation, sequence: seq, reset, ...(includeText ? { text: script?.text ?? '' } : {}),
        });
      });
    } catch (error) {
      output?.close();
      throw error;
    }
    publish();
  };
  function openPresenter(noteId?: string): void {
    if (controller && !controller.isDestroyed()) {
      controller.show(); controller.focus();
      if (noteId) controller.webContents.send('presentation:note', noteId);
      return;
    }
    controller = createController(`/present${noteId ? `?noteId=${encodeURIComponent(noteId)}` : ''}`);
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1440, area.width);
    const height = Math.min(920, area.height);
    controller.setBounds({ width, height, x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2) });
    const contents = controller.webContents;
    const controllerId = contents.id;
    controller.on('closed', () => {
      const owned = outputOwner === controllerId;
      controller = null;
      if (owned) output?.close();
    });
    contents.on('render-process-gone', () => { if (outputOwner === contents.id) output?.close(); });
    controller.webContents.on('did-start-navigation', (_event, url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace && new URL(url).pathname !== '/present' && outputOwner === contents.id) output?.close();
    });
  }
  async function toRenderer(request: CommandRequest): Promise<void> {
    const target = open(request.command === 'speak' ? 'chat' : 'workspace');
    if (request.command === 'speak' && voiceOwner !== target.webContents.id) {
      voiceOwner = target.webContents.id;
      target.once('closed', () => {
        voiceOwner = null;
        state.recording = false; state.transcribing = false; publish();
      });
    }
    if (!ready.has(target.webContents.id)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer);
          ipcMain.removeListener('desktop:ready', whenReady);
          target.removeListener('closed', closed);
        };
        const whenReady = (event: IpcMainInvokeEvent): void => {
          if (event.sender.id !== target.webContents.id) return;
          if (event.senderFrame !== event.sender.mainFrame || !isAthenaFrame(event.senderFrame.url, origin)) return;
          cleanup(); resolve();
        };
        const closed = (): void => { cleanup(); reject(new Error('Athena window closed before the command could run.')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Sign in and open Athena, then press the key again. This command has not been queued.')); }, 8000);
        ipcMain.on('desktop:ready', whenReady);
        target.once('closed', closed);
      });
    }
    parseCommand(request);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(request.id); reject(new Error('Athena did not complete the command. Check the open window before retrying.')); }, 60_000);
      pending.set(request.id, {
        sender: target.webContents.id,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      if (!target.isDestroyed()) target.webContents.send('desktop:command', request);
      else {
        pending.delete(request.id); clearTimeout(timer);
        reject(new Error('Athena window closed before the command could run.'));
      }
    });
  }
  async function execute(request: CommandRequest): Promise<void> {
    try {
      state.error = null;
      switch (request.command) {
        case 'open-athena': open('workspace'); break;
        case 'new-note': case 'new-diagram': case 'speak': await toRenderer(request); break;
        case 'present-note': await toRenderer(request); break;
        default: {
          if (!outputReady) throw new Error('Choose a script and connect the Prompter in Present first.');
          const wasEnded = state.presentation.status === 'ended' || state.presentation.progress >= 1;
          state.presentation = playbackCommand(state.presentation, request.command);
          await sendOutput(request.command === 'stop' || wasEnded);
          if (['faster', 'slower', 'text-larger', 'text-smaller'].includes(request.command)) await saveSettings();
        }
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Desktop command failed.';
      publish();
      throw error;
    }
    publish();
  }
  const bridge = new ElgatoBridge(execute, () => state);
  const trusted = (event: IpcMainInvokeEvent, controllerOnly = false): void => {
    if (event.senderFrame !== event.sender.mainFrame || !isAthenaFrame(event.senderFrame.url, origin)
      || (controllerOnly && event.sender !== controller?.webContents)) throw new Error('This window cannot control presentation.');
  };
  const handle = (name: string, fn: (event: IpcMainInvokeEvent, value: unknown) => unknown, controllerOnly = true): void => {
    ipcMain.handle(name, async (event, value: unknown) => {
      trusted(event, controllerOnly);
      await configLoaded;
      return fn(event, value);
    });
  };
  ipcMain.on('desktop:ready', event => {
    if (event.senderFrame === event.sender.mainFrame && isAthenaFrame(event.senderFrame.url, origin)) {
      ready.add(event.sender.id);
      event.sender.once('did-start-loading', () => ready.delete(event.sender.id));
    }
  });
  ipcMain.on('desktop:reply', (event, reply: Reply) => {
    if (!reply || typeof reply.id !== 'string') return;
    const item = pending.get(reply.id);
    if (!item || item.sender !== event.sender.id || event.senderFrame !== event.sender.mainFrame || !isAthenaFrame(event.senderFrame.url, origin)) return;
    pending.delete(reply.id);
    if (reply.error !== undefined) item.reject(new Error(String(reply.error) || 'Desktop command failed.'));
    else item.resolve();
  });
  handle('presentation:open', (_event, value) => {
    if (value !== undefined && (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))) throw new Error('Invalid note ID.');
    openPresenter(typeof value === 'string' ? value : undefined);
  }, false);
  handle('presentation:displays', () => screen.getAllDisplays().map(d => ({
    id: d.id, label: d.label || `Display ${d.id}`, width: d.size.width, height: d.size.height,
    scale: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id,
    preferred: config.display === fingerprint(d),
  })));
  handle('presentation:identify', async (_event, value) => {
    const display = screen.getAllDisplays().find(d => d.id === value);
    if (!display) throw new Error('Display disconnected.');
    const marker = new BrowserWindow({ ...display.bounds, frame: false, alwaysOnTop: true, backgroundColor: '#080808',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await marker.loadURL(`data:text/html,${encodeURIComponent(`<body style="background:#080808;color:#3ddbd9;font:48px Segoe UI;display:grid;place-items:center;height:90vh">Athena output: display ${display.id}</body>`)}`);
    setTimeout(() => { if (!marker.isDestroyed()) marker.close(); }, 2000);
  });
  handle('presentation:state', () => state);
  handle('presentation:close', () => { output?.close(); });
  handle('presentation:release', event => { if (outputOwner === event.sender.id) output?.close(); }, false);
  handle('presentation:command', (_event, value) => execute(parseCommand(value)));
  handle('presentation:options', async (_event, value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid output options.');
    const options = value as Record<string, unknown>;
    if (Object.keys(options).some(k => !['mirror', 'flip', 'opacity'].includes(k)) || typeof options.mirror !== 'boolean' || typeof options.flip !== 'boolean'
      || (options.opacity !== undefined && (typeof options.opacity !== 'number' || !Number.isFinite(options.opacity) || options.opacity < 20 || options.opacity > 100))) throw new Error('Invalid output options.');
    state.presentation = { ...state.presentation, mirror: options.mirror, flip: options.flip,
      opacity: typeof options.opacity === 'number' ? options.opacity : state.presentation.opacity };
    await saveSettings();
    output?.setOpacity(state.presentation.opacity / 100);
    if (outputReady) await sendOutput();
    else publish();
  });
  async function startOutput(event: IpcMainInvokeEvent, value: unknown, direct = false): Promise<void> {
    if (starting) throw new Error('A presentation is already opening. Try again when it is ready.');
    starting = true;
    let created: BrowserWindow | null = null;
    try {
      if (!value || typeof value !== 'object') throw new Error('Choose a saved note and display.');
      const v = value as Record<string, unknown>;
      if (typeof v.noteId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.noteId)
        || typeof v.title !== 'string' || v.title.length > 1000
        || typeof v.text !== 'string' || !v.text.trim() || v.text.length > 500_000) throw new Error('Choose a non-empty saved note (up to 500,000 characters).');
      const matches = screen.getAllDisplays().filter(d => direct ? fingerprint(d) === config.display : d.id === v.displayId);
      if (matches.length !== 1) throw new Error(direct ? 'Set your output display once in Athena > Presentation and Stream Deck, then try Present again.' : 'Choose an available output display.');
      const display = matches[0]!;
      if (display.id === screen.getPrimaryDisplay().id) throw new Error('Choose a separate output display. Presenter controls stay on your primary display.');
      try {
        await wakePresentationDisplay();
      } catch (error) {
        console.warn('[Presentation] Display wake request failed; continuing on the available output display:', error);
      }
      if (direct && outputReady && output && outputOwner === event.sender.id && script?.noteId === v.noteId && script.text === v.text && state.presentation.displayId === display.id) {
        state.error = null;
        output.showInactive();
        publish();
        return;
      }
      const resumeProgress = script !== null && script.noteId === v.noteId && script.text === v.text
        ? state.presentation.progress : 0;
      config.display = fingerprint(display);
      config.noteId = v.noteId;
      await persist();
      trusted(event, !direct);
      state.error = null;
      output?.close();
      script = { noteId: v.noteId, title: v.title, text: v.text };
      state.presentation = { ...state.presentation, sessionId: randomUUID(), noteId: script.noteId, title: script.title,
        displayId: display.id, status: 'ready', progress: resumeProgress, error: null };
      const win = new BrowserWindow({
        ...display.bounds, frame: false, show: false, backgroundColor: '#080808', autoHideMenuBar: true,
        focusable: false, alwaysOnTop: true, resizable: false, movable: false,
        webPreferences: { preload: join(__dirname, 'outputPreload.js'), sandbox: true, contextIsolation: true,
          nodeIntegration: false, backgroundThrottling: false },
      });
      created = win;
      output = win;
      outputOwner = event.sender.id;
      const ownerClosed = (): void => { if (output === win) win.close(); };
      const ownerLoading = (): void => { if (outputOwner !== controller?.webContents.id) ownerClosed(); };
      event.sender.once('destroyed', ownerClosed);
      event.sender.once('render-process-gone', ownerClosed);
      event.sender.once('did-start-loading', ownerLoading);
      outputReady = false;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('will-attach-webview', event => event.preventDefault());
      win.on('closed', () => {
        event.sender.removeListener('destroyed', ownerClosed);
        event.sender.removeListener('render-process-gone', ownerClosed);
        event.sender.removeListener('did-start-loading', ownerLoading);
        if (output !== win) return;
        output = null;
        disconnected('Output closed. Use Present or Play to reopen it with your saved settings.');
      });
      win.setOpacity(state.presentation.opacity / 100);
      win.webContents.on('render-process-gone', () => { if (output === win) { win.close(); } });
      await win.loadFile(join(app.getAppPath(), 'assets', 'presentation.html'));
      if (!outputReady) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { clearInterval(check); reject(new Error('Presentation output could not initialize.')); }, 3000);
        const check = setInterval(() => { if (outputReady) { clearInterval(check); clearTimeout(timer); resolve(); } }, 20);
      });
      await sendOutput(true, true);
      win.showInactive();
      publish();
    } catch (error) {
      created?.close();
      throw error;
    } finally { starting = false; }
  }
  handle('presentation:start', (event, value) => startOutput(event, value));
  handle('presentation:direct', (event, value) => {
    if (new URL(event.senderFrame!.url).pathname !== '/think') throw new Error('Present a saved note from Think.');
    return startOutput(event, value, true);
  }, false);
  ipcMain.on('presentation:ready', event => {
    if (event.sender === output?.webContents && event.senderFrame === event.sender.mainFrame) outputReady = true;
  });
  ipcMain.on('presentation:progress', (event, value: unknown) => {
    if (event.sender !== output?.webContents || event.senderFrame !== event.sender.mainFrame || !value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (v.sessionId !== state.presentation.sessionId || typeof v.progress !== 'number' || !Number.isFinite(v.progress)) return;
    state.presentation.progress = Math.max(0, Math.min(1, v.progress));
    if (v.ended === true && state.presentation.status === 'playing') state.presentation.status = 'ended';
    if (typeof v.ack === 'number') { outputAcks.get(v.ack)?.(); outputAcks.delete(v.ack); }
    publish();
  });
  handle('desktop:voice-state', (event, value) => {
    if (new URL(event.senderFrame!.url).pathname !== '/chat' || !value || typeof value !== 'object') throw new Error('Voice state belongs to chat.');
    const v = value as Record<string, unknown>;
    if (typeof v.recording !== 'boolean' || typeof v.transcribing !== 'boolean') throw new Error('Invalid voice state.');
    state = { ...state, recording: v.recording, transcribing: v.transcribing };
    publish();
  }, false);
  handle('elgato:status', () => ({ enabled: token !== '', error: bridgeError }));
  handle('elgato:pair', async () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    await bridge.stop();
    token = '';
    const next = randomBytes(32).toString('hex');
    await bridge.start(next);
    config.encryptedToken = safeStorage.encryptString(next).toString('base64');
    try { await persist(); } catch (error) { await bridge.stop(); throw error; }
    token = next; bridgeError = null;
    clipboard.writeText(token);
    return { enabled: true, error: null };
  });
  handle('elgato:copy', () => {
    if (!token) throw new Error('Enable and pair Stream Deck first.');
    clipboard.writeText(token);
  });
  handle('elgato:revoke', async () => {
    await bridge.stop(); token = ''; delete config.encryptedToken; await persist();
    return { enabled: false, error: null };
  });
  screen.on('display-removed', (_event, display) => {
    if (display.id === state.presentation.displayId) {
      const win = output; output = null; win?.close();
      disconnected('Prompter disconnected. Reconnect it and explicitly reopen the output.');
    }
  });
  screen.on('display-metrics-changed', (_event, display) => {
    if (!output || display.id !== state.presentation.displayId) return;
    if (display.id === screen.getPrimaryDisplay().id) {
      output.close();
      return;
    }
    output.setBounds(display.bounds);
  });
  app.on('before-quit', () => { void bridge.stop(); if (awake !== null) powerSaveBlocker.stop(awake); });
  configLoaded = (async () => {
    try {
      const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid Stream Deck configuration.');
      const saved = parsed as Record<string, unknown>;
      config = { ...(typeof saved.display === 'string' ? { display: saved.display } : {}),
        ...(typeof saved.noteId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(saved.noteId) ? { noteId: saved.noteId } : {}),
        ...(typeof saved.encryptedToken === 'string' ? { encryptedToken: saved.encryptedToken } : {}) };
      state.presentation.noteId = config.noteId ?? null;
      if (saved.settings && typeof saved.settings === 'object') {
        const s = saved.settings as Record<string, unknown>;
        if (typeof s.speed !== 'number' || s.speed < 10 || s.speed > 300 || !Number.isFinite(s.speed)
          || typeof s.fontSize !== 'number' || s.fontSize < 24 || s.fontSize > 96 || !Number.isFinite(s.fontSize)
          || typeof s.mirror !== 'boolean' || typeof s.flip !== 'boolean'
          || typeof s.opacity !== 'number' || s.opacity < 20 || s.opacity > 100 || !Number.isFinite(s.opacity)) throw new Error('Invalid saved presentation settings.');
        config.settings = { speed: s.speed, fontSize: s.fontSize, mirror: s.mirror, flip: s.flip, opacity: s.opacity };
        state.presentation = { ...state.presentation, ...config.settings };
      }
      if (config.encryptedToken) {
        const decrypted = safeStorage.decryptString(Buffer.from(config.encryptedToken, 'base64'));
        await bridge.start(decrypted); token = decrypted;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      bridgeError = error instanceof Error ? error.message : 'Stream Deck could not connect.';
      console.error('[Stream Deck] Setup failed:', bridgeError);
    }
  })();
  return () => openPresenter();
}
