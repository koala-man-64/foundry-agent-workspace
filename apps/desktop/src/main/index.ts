import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { RpcMethods, type RpcMethod, type Snapshot, type ModelProfile } from '../../../../packages/protocol/src/index';
import { CredentialVault } from './credentials';
import { RuntimeSupervisor } from './supervisor';

let window: BrowserWindow | undefined;
let runtime: RuntimeSupervisor | undefined;
let quitting = false;
app.setName('Foundry Agent Workspace');
app.setPath('userData', join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'FoundryAgentWorkspace'));
if (process.env.FOUNDRY_WORKSPACE_TEST_DATA && !app.isPackaged) app.setPath('userData', resolve(process.env.FOUNDRY_WORKSPACE_TEST_DATA));
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({ width: 1480, height: 940, minWidth: 1000, minHeight: 680, show: false, backgroundColor: '#142723', title: 'Foundry Agent Workspace', webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const dataDirectory = app.getPath('userData');
    const vault = new CredentialVault(join(dataDirectory, 'credentials'));
    // Coordinated mode can be enabled before release qualification only for unpackaged development/test runs.
    const runtimeEnvironment: Record<string, string> = !app.isPackaged && process.env.FOUNDRY_WORKSPACE_ENABLE_COORDINATED === '1' ? { FOUNDRY_WORKSPACE_ENABLE_COORDINATED: '1' } : {};
    runtime = new RuntimeSupervisor(join(__dirname, 'runtime.js'), dataDirectory, event => { if (!window?.isDestroyed()) window?.webContents.send('workspace:event', event); }, () => { if (!window?.isDestroyed()) window?.webContents.send('workspace:event', { sequence: 0, type: 'runtime.stopped', data: {}, createdAt: new Date().toISOString() }); }, runtimeEnvironment);
    runtime.start();
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    const expectedUrl = !app.isPackaged && developmentUrl ? new URL(developmentUrl) : pathToFileURL(join(__dirname, '../renderer/index.html'));
    if (!app.isPackaged && developmentUrl && (expectedUrl.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(expectedUrl.hostname) || expectedUrl.username || expectedUrl.password)) throw new Error('Development UI must use a local HTTP origin.');
    const authorize = (event: Electron.IpcMainInvokeEvent): void => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      const actual = new URL(event.senderFrame.url);
      if (actual.origin !== expectedUrl.origin || actual.pathname !== expectedUrl.pathname) throw new Error('Untrusted IPC origin.');
    };
    const binding = (profile: ModelProfile): string => JSON.stringify([profile.apiKind, profile.endpoint, profile.deployment]);
    const credentialsLoaded = new Set<string>();
    ipcMain.handle('workspace:invoke', async (event, method: unknown, params: unknown) => {
      authorize(event);
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(RpcMethods, method)) throw new Error('Unsupported operation.');
      const validated = RpcMethods[method as RpcMethod].parse(params);
      if (method === 'profile.save') {
        const next = validated as ModelProfile;
        const before = await runtime!.request('workspace.snapshot', {}) as Snapshot;
        const previous = before.profiles.find(profile => profile.id === next.id);
        if (!previous || binding(previous) !== binding(next)) credentialsLoaded.delete(next.id);
      }
      // Credentials never enter a renderer request or response, history, or logs.
      if (method === 'task.send' || method === 'profile.probe' || method === 'orchestration.resume') {
        const snapshot = await runtime!.request('workspace.snapshot', {}) as Snapshot;
        const taskId = method === 'orchestration.resume' ? (validated as { rootTaskId: string }).rootTaskId : (validated as { taskId?: string }).taskId;
        const task = snapshot.tasks.find(item => item.id === taskId);
        // A coordinated root schedules children with its explicitly configured child profiles.
        const profileIds = method === 'profile.probe' ? [(validated as { profileId: string }).profileId] : task ? [task.profileId, ...(task.coordination?.childProfileIds ?? [])] : [];
        for (const profileId of new Set(profileIds)) {
          if (credentialsLoaded.has(profileId)) continue;
          const profile = snapshot.profiles.find(value => value.id === profileId);
          const credential = profile ? await vault.load(profileId, binding(profile)) : undefined;
          if (credential && profile) await runtime!.request('runtime.credential', { id: profileId, value: credential, binding: binding(profile) });
          credentialsLoaded.add(profileId);
        }
      }
      return runtime!.request(method, validated);
    });
    ipcMain.handle('workspace:pick-project', async event => {
      authorize(event);
      const result = await dialog.showOpenDialog(window!, { title: 'Select a Git repository', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('workspace:save-credential', async (event, profileId: unknown, value: unknown) => {
      authorize(event);
      const id = z.string().uuid().parse(profileId); const secret = z.string().min(4).max(8192).parse(value);
      const snapshot = await runtime!.request('workspace.snapshot', {}) as Snapshot;
      const profile = snapshot.profiles.find(profile => profile.id === id);
      if (!profile) throw new Error('Save the profile before its credential.');
      await runtime!.request('runtime.credential', { id, value: secret, binding: binding(profile) });
      await vault.save(id, secret, binding(profile)); credentialsLoaded.add(id);
    });
    if (!app.isPackaged && developmentUrl) await window.loadURL(developmentUrl);
    else await window.loadFile(join(__dirname, '../renderer/index.html'));
    window.show();
  }).catch(() => { dialog.showErrorBox('Foundry Workspace could not start', 'The local runtime could not start. Check the installation and retain application data for recovery.'); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !runtime) return;
  event.preventDefault(); quitting = true;
  void runtime.stop().finally(() => app.quit());
});
