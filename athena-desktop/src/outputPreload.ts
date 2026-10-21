import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('athenaOutput', {
  onUpdate: (listener: (value: unknown) => void) => {
    ipcRenderer.on('presentation:update', (_event: IpcRendererEvent, value: unknown) => listener(value));
    ipcRenderer.send('presentation:ready');
  },
  report: (value: unknown) => ipcRenderer.send('presentation:progress', value),
});
