import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, WorkspaceEvent } from '../../../../packages/protocol/src/index';
// Expose capabilities, never the ipcRenderer object or arbitrary IPC channels.
const api = {
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
