import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserCommand, BrowserState, DesktopApi, WorkspaceEvent } from '../../../../packages/protocol/src/index';
// Expose capabilities, never the ipcRenderer object or arbitrary IPC channels.
const api = {
  browser: (command: BrowserCommand) => ipcRenderer.invoke('workspace:browser', command),
  onBrowserState: (listener: (state: BrowserState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BrowserState): void => listener(payload);
    ipcRenderer.on('workspace:browser-state', handler);
    return () => ipcRenderer.removeListener('workspace:browser-state', handler);
  },
  invoke: (method: string, params: unknown) => ipcRenderer.invoke('workspace:invoke', method, params),
  pickProject: () => ipcRenderer.invoke('workspace:pick-project'),
  saveCredential: (profileId: string, value: string) => ipcRenderer.invoke('workspace:save-credential', profileId, value),
  onEvent: (listener: (event: WorkspaceEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: WorkspaceEvent): void => listener(payload);
    ipcRenderer.on('workspace:event', handler);
    return () => ipcRenderer.removeListener('workspace:event', handler);
  }
} as DesktopApi;
contextBridge.exposeInMainWorld('workspace', api);
