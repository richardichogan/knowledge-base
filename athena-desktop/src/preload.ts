/**
 * Exposes `window.athenaDesktop` to the Athena site only. Runs sandboxed, so it
 * can only use `electron`; every call is checked again in the main process.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const originArg = process.argv.find((a) => a.startsWith('--athena-origin='));
const athenaOrigin = originArg?.slice('--athena-origin='.length) ?? '';
const versionArg = process.argv.find((a) => a.startsWith('--athena-version='));

if (athenaOrigin !== '' && window.location.origin === athenaOrigin) {
  contextBridge.exposeInMainWorld('athenaDesktop', {
    version: versionArg?.slice('--athena-version='.length) ?? '',
    device: () => ipcRenderer.invoke('athena:device'),
    listFolders: () => ipcRenderer.invoke('athena:list-folders'),
    addFolder: () => ipcRenderer.invoke('athena:add-folder'),
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
  });
}
