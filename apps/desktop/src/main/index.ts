import { app, BrowserWindow, dialog, ipcMain, Notification, session } from 'electron';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { RpcMethods, BrowserCommandSchema, BrowserStateSchema, BrowserHostError, type BrowserState, type RpcMethod, type TaskRead, type ModelProfile } from '../../../../packages/protocol/src/index';
import { profileFingerprint } from '../../../../packages/runtime/src/profile-fingerprint';
import { BrowserManager } from './browser-manager';
import { createHash } from 'node:crypto';
import { CredentialVault } from './credentials';
import { RuntimeSupervisor } from './supervisor';
import { NotificationPreferences, notificationTitle } from './notification-preferences';

let window: BrowserWindow | undefined;
let runtime: RuntimeSupervisor | undefined;
let browser: BrowserManager | undefined;
let browserState: BrowserState = { tabs: [], activeTabId: null };
let quitting = false;
app.setName('Foundry Agent Workspace');
app.setPath('userData', join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'FoundryAgentWorkspace'));
if (process.env.FOUNDRY_WORKSPACE_TEST_DATA && !app.isPackaged) app.setPath('userData', resolve(process.env.FOUNDRY_WORKSPACE_TEST_DATA));
// Chromium profile databases are separate from the runtime-owned workspace database.
const browserData = join(app.getPath('userData'), 'browser-data');
mkdirSync(browserData, { recursive: true });
app.setPath('sessionData', browserData);
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
    const notifications = new NotificationPreferences(join(dataDirectory, 'notification-preferences.json')); await notifications.load();
    const notified = new Map<string, string>();
    const attachments = new Set<{ taskId: string; cancelled: boolean }>();
    // Coordinated mode can be enabled before release qualification only for unpackaged development/test runs.
    const runtimeEnvironment: Record<string, string> = !app.isPackaged && process.env.FOUNDRY_WORKSPACE_ENABLE_COORDINATED === '1' ? { FOUNDRY_WORKSPACE_ENABLE_COORDINATED: '1' } : {};
    const publishBrowser = (state: BrowserState): void => {
      const next = BrowserStateSchema.parse(state);
      for (const previous of browserState.tabs) {
        const current = next.tabs.find(tab => tab.id === previous.id);
        if (previous.attachedTaskId && (!current || current.generation !== previous.generation || current.attachedTaskId !== previous.attachedTaskId || (previous.sharing && !current.sharing))) runtime?.invalidateBrowser(previous.attachedTaskId, previous.id);
      }
      browserState = next;
      if (!window?.isDestroyed()) window?.webContents.send('workspace:browser-state', next);
    };
    const ensureBrowser = (): BrowserManager => browser ??= new BrowserManager(window!, publishBrowser);
    runtime = new RuntimeSupervisor(join(__dirname, 'runtime.js'), dataDirectory, event => {
      if (!window?.isDestroyed()) window?.webContents.send('workspace:event', event);
      const title = notificationTitle(event); const key = `${event.type}:${event.taskId ?? ''}`;
      const fields = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
      const value = createHash('sha256').update(['approvalId', 'state', 'assignmentId', 'reason'].map(name => typeof fields[name] === 'string' ? fields[name].slice(0, 512) : '').join('\0')).digest('hex');
      if (!notifications.enabled || !title || notified.get(key) === value || !Notification.isSupported()) return;
      notified.set(key, value); if (notified.size > 500) notified.delete(notified.keys().next().value!);
      const toast = new Notification({ title: `Foundry · ${title}`, body: 'Open the workspace to review the recorded evidence. Pending work remains in Inbox.' });
      toast.on('click', () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); window.webContents.send('workspace:event', { sequence: 0, type: 'notification.open', taskId: event.rootTaskId ?? event.taskId, data: {}, createdAt: new Date().toISOString() }); } });
      try { toast.show(); } catch { /* OS delivery is optional; durable Inbox remains available. */ }
    }, () => {
      for (const guard of attachments) guard.cancelled = true;
      for (const tab of browserState.tabs) void browser?.command({ kind: 'takeControl', tabId: tab.id }).catch(() => undefined);
      if (!window?.isDestroyed()) window?.webContents.send('workspace:event', { sequence: 0, type: 'runtime.stopped', data: {}, createdAt: new Date().toISOString() });
    }, runtimeEnvironment, { request: async input => {
      if (!browser) {
        if (input.kind === 'tabs') return [];
        if (input.kind === 'revoke') return null;
        throw new BrowserHostError('stale', 'Open a browser tab and attach it to this chat first.');
      }
      return browser.request(input);
    } });
    runtime.start();
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    const expectedUrl = !app.isPackaged && developmentUrl ? new URL(developmentUrl) : pathToFileURL(join(__dirname, '../renderer/index.html'));
    if (!app.isPackaged && developmentUrl && (expectedUrl.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(expectedUrl.hostname) || expectedUrl.username || expectedUrl.password)) throw new Error('Development UI must use a local HTTP origin.');
    const authorize = (event: Electron.IpcMainInvokeEvent): void => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      let actual: URL;
      // An unparsable frame URL is never the loaded renderer, and an unusable URL must not surface a parser error.
      try { actual = new URL(event.senderFrame.url); } catch { throw new Error('Untrusted IPC origin.'); }
      // `origin` is the opaque value "null" for file: and for every non-special scheme alike, so it cannot
      // separate the packaged renderer from a foreign scheme carrying the same path; compare the scheme too.
      if (actual.protocol !== expectedUrl.protocol || actual.origin !== expectedUrl.origin || actual.pathname !== expectedUrl.pathname) throw new Error('Untrusted IPC origin.');
    };
    const binding = (profile: ModelProfile): string => JSON.stringify([profile.apiKind, profile.endpoint, profile.deployment]);
    const credentialsLoaded = new Set<string>();
    ipcMain.handle('workspace:browser', async (event, input: unknown) => {
      authorize(event);
      const command = BrowserCommandSchema.parse(input);
      if (command.kind === 'attach') {
        const guard = { taskId: command.taskId, cancelled: false };
        attachments.add(guard);
        try {
          const { task } = await runtime!.request('task.read', { taskId: command.taskId }) as TaskRead;
          if (!task || task.retiredAt || task.status === 'retired' || task.mode === 'coordinated' || task.rootTaskId || task.parentTaskId) throw new Error('Attach the tab to an active ordinary chat or coding task.');
          const profile = await runtime!.request('profile.read', { profileId: task.profileId }) as ModelProfile | null;
          if (!profile || (profile.apiKind !== 'fake' && (!profile.capabilities?.tools || !profile.capabilities.continuation || profile.verificationFingerprint !== profileFingerprint(profile)))) throw new Error('Probe this chat’s model for tools and continuation before attaching a browser tab.');
          if (guard.cancelled) throw new Error('Task execution changed during attachment. Review the task before attaching again.');
          const state = await ensureBrowser().command(command);
          if (guard.cancelled) {
            await browser?.request({ kind: 'revoke', taskId: command.taskId });
            throw new Error('Task execution changed during attachment. Review the task before attaching again.');
          }
          return BrowserStateSchema.parse(state);
        } finally { attachments.delete(guard); }
      }
      return BrowserStateSchema.parse(await ensureBrowser().command(command));
    });
    ipcMain.handle('workspace:notification-preferences', event => { authorize(event); return { enabled: notifications.enabled }; });
    ipcMain.handle('workspace:set-notifications', async (event, value: unknown) => { authorize(event); return notifications.set(z.boolean().parse(value)); });
    ipcMain.handle('workspace:invoke', async (event, method: unknown, params: unknown) => {
      authorize(event);
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(RpcMethods, method)) throw new Error('Unsupported operation.');
      const validated = RpcMethods[method as RpcMethod].parse(params);
      if (method === 'task.cancel' || method === 'task.retire') {
        const taskId = (validated as { taskId: string }).taskId;
        for (const guard of attachments) if (guard.taskId === taskId) guard.cancelled = true;
        await browser?.request({ kind: 'revoke', taskId });
      }
      if (method === 'profile.save') {
        const next = validated as ModelProfile;
        const previous = await runtime!.request('profile.read', { profileId: next.id }) as ModelProfile | null;
        if (!previous || binding(previous) !== binding(next)) credentialsLoaded.delete(next.id);
      }
      // Credentials never enter a renderer request or response, history, or logs.
      if (method === 'task.start' || method === 'task.send' || method === 'profile.probe' || method === 'orchestration.resume') {
        const taskId = method === 'orchestration.resume' ? (validated as { rootTaskId: string }).rootTaskId : (validated as { taskId?: string }).taskId;
        const task = taskId ? (await runtime!.request('task.read', { taskId }) as TaskRead).task : undefined;
        // A coordinated root schedules children with its explicitly configured child profiles.
        const start = method === 'task.start' ? validated as { profileId: string; coordination?: { childProfileIds: string[] } } : undefined;
        const profileIds = start ? [start.profileId, ...(start.coordination?.childProfileIds ?? [])]
          : method === 'profile.probe' ? [(validated as { profileId: string }).profileId]
          : task ? [task.profileId, ...(task.coordination?.childProfileIds ?? [])] : [];
        for (const profileId of new Set(profileIds)) {
          if (credentialsLoaded.has(profileId)) continue;
          const profile = await runtime!.request('profile.read', { profileId }) as ModelProfile | null;
          const credential = profile ? await vault.load(profileId, binding(profile)) : undefined;
          if (credential && profile) await runtime!.request('runtime.credential', { id: profileId, value: credential, binding: binding(profile) });
          credentialsLoaded.add(profileId);
        }
      }
      return runtime!.request(method, validated);
    });
    ipcMain.handle('workspace:pick-project', async event => {
      authorize(event);
      browser?.hide();
      try {
        const result = await dialog.showOpenDialog(window!, { title: 'Add a project folder', properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0] ?? null;
      } finally { browser?.restore(); }
    });
    ipcMain.handle('workspace:save-credential', async (event, profileId: unknown, value: unknown) => {
      authorize(event);
      const id = z.string().uuid().parse(profileId); const secret = z.string().min(4).max(8192).parse(value);
      const profile = await runtime!.request('profile.read', { profileId: id }) as ModelProfile | null;
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
  void runtime.stop().finally(() => browser?.shutdown()).finally(() => app.quit()).catch(() => undefined);
});
