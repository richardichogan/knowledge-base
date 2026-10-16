/** Athena Desktop: the Athena site in its own window, plus access to folders the user chooses on this PC. */
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { autoUpdater } from 'electron-updater';
import { watch, type FSWatcher } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { FolderRegistry, guardPath, type LocalFolder } from './folders';
import { readFileBytes, readText, writeText } from './fileAccess';
import { classifyUrl, isAthenaFrame } from './navigation';
import { isIndexable, Scanner } from './scanner';

const ATHENA_URL = process.env.ATHENA_URL ?? 'https://athena.themicrosoftcloudblog.com';
const ATHENA_ORIGIN = new URL(ATHENA_URL).origin;

let mainWindow: BrowserWindow | null = null;
let registry: FolderRegistry;
const scanner = new Scanner();
const watchers = new Map<string, FSWatcher>();
let changeTimer: NodeJS.Timeout | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start).catch((err: unknown) => {
    dialog.showErrorBox('Athena could not start', err instanceof Error ? err.message : String(err));
    app.quit();
  });
  app.on('window-all-closed', () => { app.quit(); });
}

async function start(): Promise<void> {
  registry = new FolderRegistry(join(app.getPath('userData'), 'local-folders.json'));
  await registry.load();
  registerIpc();
  watchFolders(await registry.folders());
  mainWindow = createWindow(ATHENA_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      console.error('Update check failed:', err);
    });
  }
}

function athenaPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    additionalArguments: [`--athena-origin=${ATHENA_ORIGIN}`, `--athena-version=${app.getVersion()}`],
  };
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 380,
    minHeight: 500,
    title: 'Athena',
    icon: join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: athenaPreferences(),
  });
  guardContents(win.webContents);
  void win.loadURL(url);
  return win;
}

function guardContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    switch (classifyUrl(url, ATHENA_ORIGIN)) {
      case 'athena':
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: athenaPreferences() } };
      case 'blank':
      case 'sign-in':
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } };
      case 'external':
        void shell.openExternal(url);
        return { action: 'deny' };
      case 'deny':
        return { action: 'deny' };
    }
  });
  contents.on('did-create-window', (child) => { guardContents(child.webContents); });
  contents.on('will-navigate', (event, url) => {
    const kind = classifyUrl(url, ATHENA_ORIGIN);
    if (kind === 'athena' || kind === 'sign-in') return;
    event.preventDefault();
    if (kind === 'external') void shell.openExternal(url);
  });
  contents.on('will-attach-webview', (event) => { event.preventDefault(); });
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isAthenaFrame(event.senderFrame?.url, ATHENA_ORIGIN)) throw new Error('Only the Athena site can use desktop features.');
    return fn(...(args as A));
  });
}

function registerIpc(): void {
  handle('athena:device', async () => ({ deviceId: (await registry.load()).deviceId, deviceName: hostname() }));
  handle('athena:list-folders', () => registry.folders());
  handle('athena:add-folder', async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options: Electron.OpenDialogOptions = { title: 'Choose a folder for Athena', properties: ['openDirectory'] };
    const picked = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
    const chosen = picked.filePaths[0];
    if (picked.canceled || chosen === undefined) return null;
    const folder = await registry.add(chosen);
    watchFolders(await registry.folders());
    return folder;
  });
  handle('athena:remove-folder', async (id: string) => {
    const removed = await registry.remove(String(id));
    watchFolders(await registry.folders());
    return removed;
  });
  handle('athena:scan', async () => scanner.scan((await registry.load()).deviceId, await registry.folders()));
  handle('athena:read-file', async (path: string) => readFileBytes(String(path), await registry.folders()));
  handle('athena:read-text', async (path: string) => readText(String(path), await registry.folders()));
  handle('athena:write-text', async (path: string, content: string) => {
    await writeText(String(path), content, await registry.folders());
  });
  handle('athena:show-in-folder', async (path: string) => {
    shell.showItemInFolder(await guardPath(String(path), await registry.folders()));
  });
  handle('athena:pick-file', async () => {
    const folders = await registry.folders();
    const first = folders[0];
    if (first === undefined) throw new Error('Add a folder in Local folders first.');
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options: Electron.OpenDialogOptions = { title: 'Choose a file for Athena', defaultPath: first.path, properties: ['openFile'] };
    const picked = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
    const chosen = picked.filePaths[0];
    if (picked.canceled || chosen === undefined) return null;
    return guardPath(chosen, folders);
  });
}

function watchFolders(folders: LocalFolder[]): void {
  const wanted = new Set(folders.map((f) => f.id));
  for (const [id, watcher] of watchers) {
    if (!wanted.has(id)) {
      watcher.close();
      watchers.delete(id);
    }
  }
  for (const folder of folders) {
    if (watchers.has(folder.id)) continue;
    try {
      const watcher = watch(folder.path, { recursive: true }, (_event, name) => {
        if (name === null || isIndexable(name.toString())) scheduleFilesChanged();
      });
      watcher.on('error', (err) => {
        console.error(`Stopped watching ${folder.path}:`, err);
        watchers.delete(folder.id);
      });
      watchers.set(folder.id, watcher);
    } catch (err) {
      console.error(`Could not watch ${folder.path}:`, err);
    }
  }
}

function scheduleFilesChanged(): void {
  if (changeTimer !== null) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    for (const win of BrowserWindow.getAllWindows()) {
      if (isAthenaFrame(win.webContents.getURL(), ATHENA_ORIGIN)) win.webContents.send('athena:files-changed');
    }
  }, 3000);
}
