import { BrowserWindow, app, clipboard, ipcMain, powerSaveBlocker, safeStorage, screen, shell, type IpcMainInvokeEvent } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ElgatoBridge } from './elgatoBridge';
import { initialPresentation, parseCommand, parsePresentationDemo, parsePresentationRuns, parsePresentationVisuals, parseVisualVideoMode, playbackCommand, type CommandRequest, type DesktopCommandState, type PresentationScript, type PresentationVideoState } from './elgatoProtocol';
import { VisualOutput } from './visualOutput';
import { DemoOutput } from './demoOutput';
import { isAthenaFrame } from './navigation';
import { wakePresentationDisplay } from './displayWake';

interface Config { encryptedToken?: string; display?: string; displayId?: number; demoDisplay?: string; demoDisplayId?: number; noteId?: string; settings?: { speed: number; fontSize: number; mirror: boolean; flip: boolean; opacity: number } }
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
  let readingPosition = 0;
  const visuals = new VisualOutput(join(app.getAppPath(), 'assets'), () => publishVideoState());
  const demo = new DemoOutput(message => {
    state.error = message;
    state.presentation = { ...state.presentation, status: 'paused' };
    void sendOutput().catch(error => { console.error('[Presentation] Could not pause after demo failure:', error); });
    publish();
  });
  let lastVideoState = '';
  let starting = false;
  let demoOpening = false;
  let script: PresentationScript | null = null;
  let state: DesktopCommandState = { protocol: 1, presentation: initialPresentation(), recording: false, transcribing: false, error: null };
  let config: Config = {};
  let configLoaded: Promise<void> = Promise.resolve();
  let token = '';
  let bridgeError: string | null = null;
  let awake: number | null = null;
  let sequence = 0;
  let voiceOwner: number | null = null;
  const pending = new Map<string, { sender: number; resolve: () => void; reject: (error: Error) => void }>();
  const outputAcks = new Map<number, () => void>();
  const configPath = join(app.getPath('userData'), 'elgato.json');
  const fingerprint = (display: Electron.Display): string =>
    `${display.label}:${display.size.width}x${display.size.height}:${display.scaleFactor}`;
  // Unnamed monitors of the same size share a fingerprint, so prefer the saved Electron display ID.
  const savedDisplay = (kind: 'output' | 'demo'): Electron.Display | null => {
    const print = kind === 'output' ? config.display : config.demoDisplay;
    const id = kind === 'output' ? config.displayId : config.demoDisplayId;
    if (print === undefined) return null;
    const displays = screen.getAllDisplays();
    const exact = displays.find(d => d.id === id && fingerprint(d) === print);
    if (exact) return exact;
    const matches = displays.filter(d => fingerprint(d) === print);
    return matches.length === 1 ? matches[0]! : null;
  };
  const rememberDisplay = (kind: 'output' | 'demo', display: Electron.Display): void => {
    if (kind === 'output') { config.display = fingerprint(display); config.displayId = display.id; }
    else { config.demoDisplay = fingerprint(display); config.demoDisplayId = display.id; }
  };
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
  function videoState(): PresentationVideoState {
    return { ...visuals.videoState(), noteId: outputReady ? script?.noteId ?? null : null,
      available: outputReady && state.presentation.status !== 'ended' && !!script?.visuals?.some(scene => scene.presenterLayout) };
  }
  function publishVideoState(): void {
    const snapshot = videoState();
    const signature = JSON.stringify(snapshot);
    if (signature === lastVideoState) return;
    lastVideoState = signature;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && isAthenaFrame(window.webContents.getURL(), origin)) {
        window.webContents.send('presentation:video-state', snapshot);
      }
    }
  }
  const publish = (): void => {
    syncAwake();
    demo.update(readingPosition, state.presentation.status === 'playing', state.presentation.status === 'ended');
    if (state.presentation.status === 'ended' && visuals.videoState().mode === 'camera') visuals.setVideoMode('off');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && isAthenaFrame(window.webContents.getURL(), origin)) {
        window.webContents.send('presentation:state', state);
      }
    }
    visuals.update(script?.visuals ?? [], readingPosition,
      state.presentation.status === 'disconnected' ? state.presentation.error : null, script?.title ?? '');
    publishVideoState();
  };
  const disconnected = (message: string): void => {
    outputReady = false;
    visuals.close();
    demo.close();
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
          state: state.presentation, sequence: seq, reset, ...(includeText ? { text: script?.text ?? '', runs: script?.runs } : {}),
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
    const target = open('workspace');
    if (request.command === 'speak' && voiceOwner !== target.webContents.id) {
      voiceOwner = target.webContents.id;
      target.once('closed', () => {
        if (voiceOwner !== target.webContents.id) return;
        voiceOwner = null;
        state.recording = false; state.transcribing = false; publish();
      });
    }
    // Ask the currently mounted receiver; a cached ready flag can outlive navigation.
    {
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
        target.webContents.send('desktop:request-ready');
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
  async function execute(request: CommandRequest, source: 'presenter' | 'stream-deck' = 'presenter'): Promise<void> {
    try {
      state.error = null;
      switch (request.command) {
        case 'open-athena': open('workspace'); break;
        case 'new-note': case 'new-diagram': case 'speak': await toRenderer(request); break;
        case 'present-note': await toRenderer(request); break;
        case 'stop-presenting': closeOutput(); break;
        default: {
          const requestsPlayback = request.command === 'play'
            || (request.command === 'toggle-play' && state.presentation.status !== 'playing');
          if (requestsPlayback && demoOpening) {
            throw new Error('The Turnaround demo is still loading. Play was not queued; press it again after the demo is ready.');
          }
          const nextPresentation = playbackCommand(state.presentation, request.command);
          const startingPlayback = state.presentation.status !== 'playing' && nextPresentation.status === 'playing';
          if (!outputReady) throw new Error('Choose a script and connect the Prompter in Present first.');
          if (startingPlayback && app.isPackaged && script?.demo?.length && source !== 'stream-deck') {
            throw new Error('In the installed app, press Play on the Stream Deck after the demo is ready.');
          }
          if (startingPlayback && app.isPackaged && script?.demo?.length && source === 'stream-deck' && !demo.isReady) {
            throw new Error('The Turnaround demo is not ready. Wait for it to finish loading, then press Play on the Stream Deck again.');
          }
          const wasEnded = state.presentation.status === 'ended' || state.presentation.progress >= 1;
          const resetDemo = request.command === 'stop' && !demoOpening && demo.isReady;
          const sessionId = state.presentation.sessionId;
          if (resetDemo) demoOpening = true;
          try {
            state.presentation = nextPresentation;
            demo.update(readingPosition, state.presentation.status === 'playing');
            await sendOutput(request.command === 'stop' || wasEnded);
            if (resetDemo) {
              if (!outputReady || state.presentation.sessionId !== sessionId || state.presentation.displayId === null) {
                throw new Error('The presentation closed before the demo could be reset.');
              }
              await demo.reset(state.presentation.displayId);
            }
            if (['faster', 'slower', 'text-larger', 'text-smaller'].includes(request.command)) await saveSettings();
          } finally {
            if (resetDemo) demoOpening = false;
          }
        }
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Desktop command failed.';
      publish();
      throw error;
    }
    publish();
  }
  const bridge = new ElgatoBridge(request => execute(request, 'stream-deck'), () => state);
  function closeOutput(): void {
    if (starting) throw new Error('The presentation is still opening. Try Stop presenting again once it opens.');
    output?.close();
    state.error = null;
    state.presentation.error = null;
    publish();
  }
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
  handle('presentation:displays', () => {
    const output = savedDisplay('output')?.id, demoDisplay = savedDisplay('demo')?.id;
    return screen.getAllDisplays().map(d => ({
      id: d.id, label: d.label || `Display ${d.id}`, width: d.size.width, height: d.size.height,
      scale: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id,
      preferred: d.id === output, preferredDemo: d.id === demoDisplay,
    }));
  });
  handle('presentation:set-display', async (_event, value) => {
    const previous = { display: config.display, displayId: config.displayId };
    if (value === null) { delete config.display; delete config.displayId; }
    else {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Choose an available output display.');
      const display = screen.getAllDisplays().find(item => item.id === value);
      if (!display || display.id === screen.getPrimaryDisplay().id) throw new Error('Choose a separate output display.');
      if (savedDisplay('demo')?.id === display.id) throw new Error('Choose a different display from the demo.');
      rememberDisplay('output', display);
    }
    try { await persist(); }
    catch (error) {
      Object.assign(config, previous);
      if (previous.display === undefined) delete config.display;
      if (previous.displayId === undefined) delete config.displayId;
      throw error;
    }
  });
  handle('presentation:set-demo-display', async (_event, value) => {
    const previous = { demoDisplay: config.demoDisplay, demoDisplayId: config.demoDisplayId };
    if (value === null) { delete config.demoDisplay; delete config.demoDisplayId; }
    else {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Choose an available demo display.');
      const display = screen.getAllDisplays().find(item => item.id === value);
      if (!display || display.id === screen.getPrimaryDisplay().id || savedDisplay('output')?.id === display.id) {
        throw new Error('Choose a demo display separate from the presenter and prompter.');
      }
      rememberDisplay('demo', display);
    }
    try { await persist(); }
    catch (error) {
      Object.assign(config, previous);
      if (previous.demoDisplay === undefined) delete config.demoDisplay;
      if (previous.demoDisplayId === undefined) delete config.demoDisplayId;
      throw error;
    }
  });
  handle('presentation:identify', async (_event, value) => {
    const display = screen.getAllDisplays().find(d => d.id === value);
    if (!display) throw new Error('Display disconnected.');
    const marker = new BrowserWindow({ ...display.bounds, frame: false, alwaysOnTop: true, backgroundColor: '#080808',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await marker.loadURL(`data:text/html,${encodeURIComponent(`<body style="background:#080808;color:#3ddbd9;font:48px Segoe UI;display:grid;place-items:center;height:90vh">Athena output: display ${display.id}</body>`)}`);
    setTimeout(() => { if (!marker.isDestroyed()) marker.close(); }, 2000);
  });
  handle('presentation:state', event => {
    if (event.sender !== controller?.webContents && new URL(event.senderFrame!.url).pathname !== '/think') {
      throw new Error('Read presentation state from Think or the presentation controls.');
    }
    return state;
  }, false);
  handle('presentation:video-state', () => videoState(), false);
  handle('presentation:video-mode', async (event, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a video mode from the script toolbar.');
    const data = value as Record<string, unknown>;
    const mode = parseVisualVideoMode(data.mode);
    if (Object.keys(data).some(key => key !== 'mode' && key !== 'noteId') || typeof data.noteId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.noteId)) throw new Error('Choose a saved script for presenter video.');
    const path = new URL(event.senderFrame!.url).pathname;
    if (path !== '/think' && path !== '/present') throw new Error('Change video mode from the script or presentation toolbar.');
    const ownsOutput = (): boolean => outputReady && script?.noteId === data.noteId;
    if (outputReady && !ownsOutput()) throw new Error('Change video mode from the script that is currently being presented.');
    if (mode === 'camera') {
      if (!ownsOutput() || !videoState().available) throw new Error('Enable Presenter layout and present this saved script before starting Camera.');
      const url = await visuals.open();
      if (!ownsOutput() || !videoState().available) throw new Error('The active presentation changed. Camera has not been started.');
      const openBrowser = !visuals.hasClients();
      visuals.setVideoMode(mode);
      if (openBrowser) {
        const requestId = visuals.videoState().requestId;
        try { await shell.openExternal(url); }
        catch (error) {
          if (visuals.videoState().requestId === requestId) visuals.setVideoMode('off');
          throw error;
        }
      }
    } else visuals.setVideoMode(mode);
    return videoState();
  }, false);
  handle('presentation:close', event => {
    if (event.sender !== controller?.webContents && new URL(event.senderFrame!.url).pathname !== '/think') {
      throw new Error('Stop presenting from Think or the presentation controls.');
    }
    closeOutput();
  }, false);
  handle('presentation:release', event => { if (outputOwner === event.sender.id) output?.close(); }, false);
  handle('presentation:command', (_event, value) => execute(parseCommand(value)));
  handle('presentation:note-command', (event, value) => {
    if (new URL(event.senderFrame!.url).pathname !== '/think' || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Control playback from the current script.');
    }
    const request = value as Record<string, unknown>;
    if ((request.command !== 'play' && request.command !== 'pause') || request.noteId !== script?.noteId || !outputReady) {
      throw new Error('Open the current script on the prompter first.');
    }
    return execute({ id: randomUUID(), command: request.command, issuedAt: Date.now() });
  }, false);
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
      const runs = parsePresentationRuns(v.runs, v.text);
      const scenes = parsePresentationVisuals(v.visuals, v.text.length);
      const actions = parsePresentationDemo(v.demo, v.text.length);
      const sameScript = script?.noteId === v.noteId && script.text === v.text
        && JSON.stringify(script.runs) === JSON.stringify(runs)
        && JSON.stringify(script.visuals) === JSON.stringify(scenes)
        && JSON.stringify(script.demo) === JSON.stringify(actions);
      const matches = direct ? [savedDisplay('output')].filter((d): d is Electron.Display => !!d)
        : screen.getAllDisplays().filter(d => d.id === v.displayId);
      if (matches.length !== 1) throw new Error(direct ? 'Set your output display once in Athena > Presentation and Stream Deck, then try Present again.' : 'Choose an available output display.');
      const display = matches[0]!;
      if (display.id === screen.getPrimaryDisplay().id) throw new Error('Choose a separate output display. Presenter controls stay on your primary display.');
      try {
        await wakePresentationDisplay();
      } catch (error) {
        console.warn('[Presentation] Display wake request failed; continuing on the available output display:', error);
      }
      if (direct && outputReady && output && outputOwner === event.sender.id && sameScript && state.presentation.displayId === display.id) {
        state.error = null;
        output.showInactive();
        publish();
        return;
      }
      const resumeProgress = sameScript
        ? state.presentation.progress : 0;
      rememberDisplay('output', display);
      config.noteId = v.noteId;
      await persist();
      trusted(event, !direct);
      state.error = null;
      output?.close();
      demo.close();
      readingPosition = 0;
      script = { noteId: v.noteId, title: v.title, text: v.text, ...(runs ? { runs } : {}), ...(scenes ? { visuals: scenes } : {}), ...(actions ? { demo: actions } : {}) };
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
  handle('presentation:demo', async (event, value) => {
    if (event.sender !== controller?.webContents && new URL(event.senderFrame!.url).pathname !== '/think') throw new Error('Open the demo from the script or Presentation.');
    if (demoOpening) throw new Error('The demo is already opening or resetting. Wait until it is ready.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a saved script and demo display.');
    const request = value as Record<string, unknown>;
    if (state.presentation.status === 'playing') throw new Error('Pause the prompter before opening the demo.');
    if (typeof request.noteId !== 'string' || typeof request.title !== 'string' || typeof request.text !== 'string'
      || typeof request.displayId !== 'number' || !Number.isSafeInteger(request.displayId)
      || typeof request.demoDisplayId !== 'number' || !Number.isSafeInteger(request.demoDisplayId)) {
      throw new Error('Choose a saved script and separate presenter and demo displays.');
    }
    const demoDisplay = screen.getAllDisplays().find(display => display.id === request.demoDisplayId);
    if (!demoDisplay || demoDisplay.id === screen.getPrimaryDisplay().id || demoDisplay.id === request.displayId) {
      throw new Error('Choose a demo display separate from the presenter and prompter.');
    }
    demoOpening = true;
    try {
      rememberDisplay('demo', demoDisplay);
      await persist();
      const activeOutput = outputReady && output && !output.isDestroyed() && outputOwner === event.sender.id
        && script?.noteId === request.noteId && script.demo?.length && state.presentation.displayId === request.displayId;
      if (!activeOutput) await startOutput(event, request);
      if (!outputReady || !script?.demo?.length || script.noteId !== request.noteId) {
        throw new Error('The saved script could not be opened for the Turnaround demo.');
      }
      await demo.open(demoDisplay.id, state.presentation.displayId, script.demo);
    } finally {
      demoOpening = false;
    }
  }, false);
  handle('presentation:visuals', async event => {
    if (!outputReady || outputOwner !== event.sender.id || !script?.visuals?.length) throw new Error('Present a saved script with visuals first.');
    visuals.update(script.visuals, readingPosition, null, script.title);
    const url = await visuals.open();
    if (!outputReady || outputOwner !== event.sender.id) { visuals.close(); throw new Error('The presentation closed before the browser output was ready.'); }
    await shell.openExternal(url);
  }, false);
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
    if (typeof v.position === 'number' && Number.isSafeInteger(v.position) && v.position >= 0 && v.position <= (script?.text.length ?? 0)) readingPosition = v.position;
    if (v.ended === true && state.presentation.status === 'playing') state.presentation.status = 'ended';
    if (typeof v.ack === 'number') { outputAcks.get(v.ack)?.(); outputAcks.delete(v.ack); }
    publish();
  });
  handle('desktop:voice-state', (event, value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid voice state.');
    const v = value as Record<string, unknown>;
    if (typeof v.recording !== 'boolean' || typeof v.transcribing !== 'boolean') throw new Error('Invalid voice state.');
    if (event.sender.id !== voiceOwner) return;
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
    demo.displayChanged(display, true, state.presentation.displayId);
    if (display.id === state.presentation.displayId) {
      const win = output; output = null; win?.close();
      disconnected('Prompter disconnected. Reconnect it and explicitly reopen the output.');
    }
  });
  screen.on('display-metrics-changed', (_event, display) => {
    demo.displayChanged(display, false, state.presentation.displayId);
    if (!output || display.id !== state.presentation.displayId) return;
    if (display.id === screen.getPrimaryDisplay().id) {
      output.close();
      return;
    }
    output.setBounds(display.bounds);
  });
  app.on('before-quit', () => { demo.close(); visuals.close(); void bridge.stop(); if (awake !== null) powerSaveBlocker.stop(awake); });
  configLoaded = (async () => {
    try {
      const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid Stream Deck configuration.');
      const saved = parsed as Record<string, unknown>;
      config = { ...(typeof saved.display === 'string' ? { display: saved.display } : {}),
        ...(Number.isSafeInteger(saved.displayId) ? { displayId: saved.displayId as number } : {}),
        ...(typeof saved.demoDisplay === 'string' ? { demoDisplay: saved.demoDisplay } : {}),
        ...(Number.isSafeInteger(saved.demoDisplayId) ? { demoDisplayId: saved.demoDisplayId as number } : {}),
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
