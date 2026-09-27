import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from './browser-manager';

const mock = vi.hoisted(() => ({ views: [] as unknown[], makeContents: null as null | (() => unknown) }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeDebugger extends EventEmitter {
    attached = false;
    throwAction = false;
    targetValid = true;
    clicks = 0;
    constructor(private readonly contents: FakeContents) { super(); }
    isAttached(): boolean { return this.attached; }
    attach(): void { this.attached = true; }
    async sendCommand(method: string, params?: { expression?: string }): Promise<unknown> {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method !== 'Runtime.evaluate') return {};
      const expression = params?.expression ?? '';
      if (expression.includes('globalThis.__foundryBrowserTargets=targets')) return { result: { value: { text: 'Fixture page', nodes: [{ id: '1', role: 'button', name: 'Apply', fingerprint: '["BUTTON",null,null,"Apply",null,null,null,null,false,null,null,null,null,null,null,null]' }], truncated: false } } };
      if (expression.startsWith("[...document.querySelectorAll('input[type=file]')]")) return { result: { value: this.contents.selectedFile } };
      if (expression.includes('globalThis.__foundryBrowserTargets?.[')) {
        if (this.throwAction && expression.includes('HTMLElement.prototype.click.call')) throw new Error('Renderer went away after dispatch');
        if (!this.targetValid) return { result: { value: null } };
        if (expression.includes('HTMLElement.prototype.click.call')) this.clicks++;
        return { result: { value: { valid: true, tag: 'BUTTON', name: 'Apply' } } };
      }
      return { result: { value: true } };
    }
  }

  class FakeContents extends EventEmitter {
    url = '';
    selectedFile = false;
    destroyed = false;
    loading = false;
    redirectTo: string | null = null;
    readonly debugger = new FakeDebugger(this);
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} };
    readonly id = mock.views.length + 1;
    popupHandler: ((input: { url: string }) => { action: string; overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> }; createWindow?: (options: { webContents?: FakeContents }) => FakeContents }) | null = null;
    setWindowOpenHandler(handler: NonNullable<FakeContents['popupHandler']>): void { this.popupHandler = handler; }
    getURL(): string { return this.url; }
    getTitle(): string { return 'Fixture'; }
    isLoading(): boolean { return this.loading; }
    isDestroyed(): boolean { return this.destroyed; }
    stop(): void { this.loading = false; }
    reload(): void {}
    close(): void { this.destroyed = true; this.emit('destroyed'); }
    async loadURL(url: string): Promise<void> {
      this.loading = true;
      this.emit('did-start-navigation');
      let destination = url;
      if (this.redirectTo) {
        destination = this.redirectTo;
        this.emit('will-redirect', { preventDefault() {} }, destination, false, true);
        this.redirectTo = null;
      }
      this.url = destination;
      this.emit('did-navigate');
      this.loading = false;
      this.emit('did-stop-loading');
    }
  }

  class FakeView {
    private readonly contents: FakeContents;
    get webContents(): FakeContents { return this.contents.destroyed ? undefined as unknown as FakeContents : this.contents; }
    constructor(options?: { webContents?: FakeContents }) {
      if (options && 'webContents' in options && !options.webContents) throw new TypeError('options.webContents must be a WebContents');
      this.contents = options?.webContents ?? new FakeContents(); mock.views.push(this);
    }
    setBounds(): void {}
  }
  mock.makeContents = () => new FakeContents();

  class FakeSession extends EventEmitter {
    readonly cookies = { flushStore: async () => {} };
    readonly webRequest = { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {} };
    setPermissionRequestHandler(): void {}
    setPermissionCheckHandler(): void {}
    async clearStorageData(): Promise<void> {}
    async clearCache(): Promise<void> {}
    async flushStorageData(): Promise<void> {}
  }

  return {
    session: { fromPartition: () => new FakeSession() },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    WebContentsView: FakeView
  };
});

type FakeContents = {
  selectedFile: boolean;
  redirectTo: string | null;
  debugger: { targetValid: boolean; throwAction: boolean; clicks: number; emit(event: string): void };
  popupHandler: ((input: { url: string }) => { action: string; overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> }; createWindow?: (options: { webContents?: FakeContents }) => FakeContents }) | null;
  emit(event: string): void;
  loadURL(url: string): Promise<void>;
  close(): void;
};
const taskA = '8a8b02a6-980c-4c42-9ad5-9623ea2599f1';
const taskB = 'e8a63d4b-3f52-45f4-9059-7d243ad4a1ea';
const view = (): FakeContents => (mock.views.at(-1) as { webContents: FakeContents }).webContents;
const host = (): BrowserManager => new BrowserManager({
  isDestroyed: () => false,
  contentView: { children: [], addChildView: () => {}, removeChildView: () => {} },
  getContentSize: () => [1200, 800]
} as never, () => {});

beforeEach(() => { mock.views.length = 0; });

describe('BrowserManager access and action authority', () => {
  it('restricts attached tabs and snapshots to the assigned chat', async () => {
    const manager = host();
    const tabId = (await manager.command({ kind: 'state' })).activeTabId!;
    await manager.command({ kind: 'attach', tabId, taskId: taskA });
    expect(await manager.request({ kind: 'tabs', taskId: taskB })).toEqual([]);
    await expect(manager.request({ kind: 'snapshot', taskId: taskB, tabId })).rejects.toMatchObject({ code: 'stale' });
    expect((await manager.request({ kind: 'tabs', taskId: taskA }) as Array<{ id: string }>)[0]?.id).toBe(tabId);
  });

  it('rejects attachment when a file was selected in manual control', async () => {
    const manager = host();
    const tabId = (await manager.command({ kind: 'state' })).activeTabId!;
    view().selectedFile = true;
    await expect(manager.command({ kind: 'attach', tabId, taskId: taskA })).rejects.toThrow('Finish upload or reload');
    expect((await manager.command({ kind: 'state' })).tabs[0]?.attachedTaskId).toBeNull();
  });

  it('adopts a secure popup WebContents into an active managed tab', async () => {
    const manager = host();
    const popup = mock.makeContents!() as FakeContents;
    const response = view().popupHandler!({ url: 'https://login.example/auth' });
    expect(response.action).toBe('allow');
    expect(response.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      partition: 'persist:workspace-browser-v1', sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true
    });
    expect(response.createWindow!({ webContents: popup })).toBe(popup);
    const state = await manager.command({ kind: 'state' });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
    expect(view()).toBe(popup);
    popup.close();
    expect((await manager.command({ kind: 'state' })).tabs).toHaveLength(1);
  });

  it('suspends sharing after an unexpected redirect origin', async () => {
    const manager = host();
    const tabId = (await manager.command({ kind: 'state' })).activeTabId!;
    await manager.command({ kind: 'attach', tabId, taskId: taskA });
    const prepared = await manager.request({ kind: 'prepare', taskId: taskA, action: { kind: 'navigate', tabId, url: 'https://first.example/path' } }) as { id: string };
    view().redirectTo = 'https://other.example/';
    await manager.request({ kind: 'execute', taskId: taskA, preparedId: prepared.id });
    expect((await manager.command({ kind: 'state' })).tabs[0]?.sharing).toBe(false);
    await expect(manager.request({ kind: 'snapshot', taskId: taskA, tabId })).rejects.toMatchObject({ code: 'stale' });
  });

  it('rejects changed targets and permits only one competing execution', async () => {
    const manager = host();
    const tabId = (await manager.command({ kind: 'state' })).activeTabId!;
    await manager.command({ kind: 'attach', tabId, taskId: taskA });
    const snapshot = await manager.request({ kind: 'snapshot', taskId: taskA, tabId }) as { id: string };
    const action = { kind: 'click' as const, tabId, snapshotId: snapshot.id, nodeId: '1' };
    const stale = await manager.request({ kind: 'prepare', taskId: taskA, action }) as { id: string };
    view().debugger.targetValid = false;
    await expect(manager.request({ kind: 'execute', taskId: taskA, preparedId: stale.id })).rejects.toMatchObject({ code: 'stale' });
    expect(view().debugger.clicks).toBe(0);
    view().debugger.targetValid = true;
    const prepared = await manager.request({ kind: 'prepare', taskId: taskA, action }) as { id: string };
    const results = await Promise.allSettled([
      manager.request({ kind: 'execute', taskId: taskA, preparedId: prepared.id }),
      manager.request({ kind: 'execute', taskId: taskA, preparedId: prepared.id })
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(view().debugger.clicks).toBe(1);
  });

  it('revokes approvals on takeover and renderer failure', async () => {
    const manager = host();
    const tabId = (await manager.command({ kind: 'state' })).activeTabId!;
    await manager.command({ kind: 'attach', tabId, taskId: taskA });
    const prepared = await manager.request({ kind: 'prepare', taskId: taskA, action: { kind: 'navigate', tabId, url: 'https://first.example/' } }) as { id: string };
    await manager.command({ kind: 'takeControl', tabId });
    await expect(manager.request({ kind: 'execute', taskId: taskA, preparedId: prepared.id })).rejects.toMatchObject({ code: 'stale' });
    await manager.command({ kind: 'attach', tabId, taskId: taskA });
    view().emit('render-process-gone');
    expect((await manager.command({ kind: 'state' })).tabs[0]?.attachedTaskId).toBeNull();
    await manager.command({ kind: 'attach', tabId, taskId: taskA });
    view().debugger.emit('detach');
    expect((await manager.command({ kind: 'state' })).tabs[0]?.attachedTaskId).toBeNull();
  });

  it('reports an unknown result after dispatch without replaying', async () => {
    const manager = host();
    const tabId = (await manager.command({ kind: 'state' })).activeTabId!;
    await manager.command({ kind: 'attach', tabId, taskId: taskA });
    const snapshot = await manager.request({ kind: 'snapshot', taskId: taskA, tabId }) as { id: string };
    const prepared = await manager.request({ kind: 'prepare', taskId: taskA, action: { kind: 'click', tabId, snapshotId: snapshot.id, nodeId: '1' } }) as { id: string };
    view().debugger.throwAction = true;
    await expect(manager.request({ kind: 'execute', taskId: taskA, preparedId: prepared.id })).rejects.toMatchObject({ code: 'unknown' });
    await expect(manager.request({ kind: 'execute', taskId: taskA, preparedId: prepared.id })).rejects.toMatchObject({ code: 'stale' });
  });
});
