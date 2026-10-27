/**
 * Exposes `window.athenaDesktop` to the Athena site only. Runs sandboxed, so it
 * can only use `electron`; every call is checked again in the main process.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CommandRequest } from './elgatoProtocol';

const originArg = process.argv.find((a) => a.startsWith('--athena-origin='));
const athenaOrigin = originArg?.slice('--athena-origin='.length) ?? '';
const versionArg = process.argv.find((a) => a.startsWith('--athena-version='));

if (process.isMainFrame && athenaOrigin !== '' && window.location.origin === athenaOrigin) {
  contextBridge.exposeInMainWorld('athenaDesktop', {
    version: versionArg?.slice('--athena-version='.length) ?? '',
    presentation: {
      open: (noteId?: string) => ipcRenderer.invoke('presentation:open', noteId),
      displays: () => ipcRenderer.invoke('presentation:displays'),
      identify: (id: number) => ipcRenderer.invoke('presentation:identify', id),
      state: () => ipcRenderer.invoke('presentation:state'),
      close: () => ipcRenderer.invoke('presentation:close'),
      start: (value: unknown) => ipcRenderer.invoke('presentation:start', value),
      present: (value: unknown) => ipcRenderer.invoke('presentation:direct', value),
      release: () => ipcRenderer.invoke('presentation:release'),
      command: (value: unknown) => ipcRenderer.invoke('presentation:command', value),
      options: (value: unknown) => ipcRenderer.invoke('presentation:options', value),
      onState: (listener: (value: unknown) => void) => {
        const handler = (_event: IpcRendererEvent, value: unknown): void => listener(value);
        ipcRenderer.on('presentation:state', handler);
        return () => { ipcRenderer.removeListener('presentation:state', handler); };
      },
      onNote: (listener: (value: string) => void) => {
        const handler = (_event: IpcRendererEvent, value: string): void => listener(value);
        ipcRenderer.on('presentation:note', handler);
        return () => { ipcRenderer.removeListener('presentation:note', handler); };
      },
      pairingStatus: () => ipcRenderer.invoke('elgato:status'),
      pair: () => ipcRenderer.invoke('elgato:pair'),
      copyKey: () => ipcRenderer.invoke('elgato:copy'),
      revoke: () => ipcRenderer.invoke('elgato:revoke'),
    },
    voiceState: (value: unknown) => ipcRenderer.invoke('desktop:voice-state', value),
    onCommand: (listener: (request: CommandRequest) => Promise<void>) => {
      const handler = (_event: IpcRendererEvent, request: CommandRequest): void => {
        Promise.resolve().then(() => listener(request)).then(
          () => ipcRenderer.send('desktop:reply', { id: request.id }),
          (error: unknown) => ipcRenderer.send('desktop:reply', { id: request.id, error: error instanceof Error ? error.message : 'Desktop command failed.' }),
        );
      };
      const ready = (): void => { ipcRenderer.send('desktop:ready'); };
      ipcRenderer.on('desktop:command', handler);
      ipcRenderer.on('desktop:request-ready', ready);
      ready();
      return () => {
        ipcRenderer.removeListener('desktop:command', handler);
        ipcRenderer.removeListener('desktop:request-ready', ready);
      };
    },
    device: () => ipcRenderer.invoke('athena:device'),
    listFolders: () => ipcRenderer.invoke('athena:list-folders'),
    addFolder: () => ipcRenderer.invoke('athena:add-folder'),
    addDailyInsights: () => ipcRenderer.invoke('athena:add-daily-insights'),
    removeFolder: (id: string) => ipcRenderer.invoke('athena:remove-folder', id),
    scan: () => ipcRenderer.invoke('athena:scan'),
    readFile: (path: string) => ipcRenderer.invoke('athena:read-file', path),
    readText: (path: string) => ipcRenderer.invoke('athena:read-text', path),
    writeText: (path: string, content: string) => ipcRenderer.invoke('athena:write-text', path, content),
    showInFolder: (path: string) => ipcRenderer.invoke('athena:show-in-folder', path),
    pickFile: () => ipcRenderer.invoke('athena:pick-file'),
    onFilesChanged: (listener: () => void) => {
      const handler = (_event: IpcRendererEvent): void => { listener(); };
      ipcRenderer.on('athena:files-changed', handler);
      return () => { ipcRenderer.removeListener('athena:files-changed', handler); };
    },
    onOpenChat: (listener: (path: string) => void) => {
      const handler = (_event: IpcRendererEvent, path: unknown): void => {
        if (typeof path === 'string' && path.startsWith('/chat')) listener(path);
      };
      ipcRenderer.on('athena:open-chat', handler);
      return () => { ipcRenderer.removeListener('athena:open-chat', handler); };
    },
  });
}
