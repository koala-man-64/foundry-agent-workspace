import { randomUUID } from 'node:crypto';
import { dialog, session, WebContentsView, type BrowserWindow, type DownloadItem, type WebContents } from 'electron';
import {
  BrowserActionSchema, BrowserCommandSchema, BrowserHostError, BrowserHostRequestSchema,
  type BrowserAction, type BrowserCommand, type BrowserHostRequest, type BrowserHostResult,
  type BrowserPrepared, type BrowserSnapshot, type BrowserState, type BrowserTab
} from '../../../../packages/protocol/src/browser';

const PARTITION = 'persist:workspace-browser-v1';
const MAX_TABS = 20;
const MAX_CHECKED_FRAMES = 64;
const FILE_CHECK_TIMEOUT_MS = 5_000;
const MAX_PREPARED_PER_TAB = 32;
const PREPARED_TTL_MS = 10 * 60_000;
type Tab = { id: string; view: WebContentsView; contents: WebContents; generation: number; attachmentId: string | null; taskId: string | null; attaching: { id: string; taskId: string; cancelled: boolean } | null; lastTaskId: string | null; authorizedOrigin: string | null; pendingOrigin: string | null; error: string | null; snapshot: BrowserSnapshot | null; fingerprints: Map<string, string>; prepared: Set<string>; downloads: Set<DownloadItem>; contextId: number | null; busy: Promise<void> };
type PreparedRecord = { value: BrowserPrepared; fingerprint?: string; consumed: boolean };
const originOf = (url: string): string => { try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : 'null'; } catch { return 'null'; } };
const safeUrl = (url: string): string => { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new BrowserHostError('failed', 'Only HTTP and HTTPS pages are supported.'); return parsed.href; };
const describe = (action: BrowserAction, tab?: Tab): string => {
  if (action.kind === 'navigate') return `Navigate to ${action.url} and share page content from ${originOf(action.url)} with this chat`;
  if (action.kind === 'scroll') return `Scroll ${action.direction} ${action.pixels} pixels`;
  const node = tab?.snapshot?.nodes.find(value => value.id === action.nodeId);
  const attributes = tab?.fingerprints.get(action.nodeId) ? JSON.parse(tab.fingerprints.get(action.nodeId)!) as Array<unknown> : [];
  const destination = [attributes[4], attributes[5], attributes[6], attributes[7]].find(value => typeof value === 'string' && value.length > 0);
  return `${action.kind} ${node?.role ?? 'element'} ${JSON.stringify(node?.name ?? action.nodeId)}${destination ? ` (destination ${destination})` : ''}${action.kind === 'fill' ? ` with ${JSON.stringify(action.text)}` : action.kind === 'select' ? ` as ${JSON.stringify(action.value)}` : action.kind === 'press' ? ` using ${action.key} (page event; browser-native keyboard shortcuts require manual control)` : ''}`;
};

// Only fixed host-authored scripts are sent to CDP. A page can influence the returned data, never the script.
const SNAPSHOT_SCRIPT = `(() => {
 const visible = e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0; };
 const safe = e => !(e.closest('[inert],[aria-hidden="true"],[contenteditable]')) && !(e instanceof HTMLInputElement && ['password','hidden','file'].includes(e.type)) && !/password|token|secret|api.?key|credential|otp|one-time-code|current-password|new-password|cvv|card|ssn/i.test([e.getAttribute('name'),e.getAttribute('id'),e.getAttribute('aria-label'),e.getAttribute('autocomplete')].join(' '));
 const label = e => (e.getAttribute('aria-label')||e.getAttribute('title')||e.getAttribute('placeholder')||e.labels?.[0]?.innerText||((e.matches('input,textarea,select'))?'':e.innerText)||'').trim().slice(0,512);
 const nodes=[], targets=[], forms=[]; for(const e of document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]')) {if(nodes.length>=300)break;if(!visible(e)||!safe(e))continue;const role=(e.getAttribute('role')||e.tagName.toLowerCase()).slice(0,80);const name=label(e);const form=e.form||e.closest('form');const fingerprint=JSON.stringify([e.tagName,e.getAttribute('type'),e.getAttribute('name'),name,e.getAttribute('href'),e.getAttribute('formaction'),e.getAttribute('action'),form?.getAttribute('action'),e.disabled,form?.getAttribute('method'),form?.getAttribute('target'),form?.getAttribute('enctype'),e.getAttribute('form'),e.getAttribute('formtarget'),e.getAttribute('formmethod'),e.getAttribute('formenctype')]);nodes.push({id:String(nodes.length+1),role,name,fingerprint});targets.push(e);forms.push(form);}
 globalThis.__foundryBrowserTargets=targets;
 globalThis.__foundryBrowserForms=forms;
 let text=''; const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walk.nextNode()&&text.length<50000){const node=walk.currentNode, p=node.parentElement;if(!p||!safe(p)||!visible(p)||p.closest('script,style,noscript,input,select,textarea,[contenteditable], [hidden]'))continue;text+=' '+(node.textContent||'');}text=text.replace(/\\s+/g,' ').trim();return {text:text.slice(0,48000),truncated:text.length>48000||nodes.length>=300,nodes};
})()`;
const TARGET_SCRIPT = (id: string, fingerprint: string, action?: BrowserAction) => `(() => {
  if([...document.querySelectorAll('input[type=file]')].some(input => input.files?.length>0))return null;
  const e=globalThis.__foundryBrowserTargets?.[${Number(id) - 1}];
  if(!e||!e.isConnected)return null;
  const s=getComputedStyle(e),r=e.getBoundingClientRect();
  if(s.display==='none'||s.visibility==='hidden'||r.width<=0||r.height<=0||e.closest('[inert],[aria-hidden="true"],[contenteditable]')||e.disabled)return null;
  const name=(e.getAttribute('aria-label')||e.getAttribute('title')||e.getAttribute('placeholder')||e.labels?.[0]?.innerText||((e.matches('input,textarea,select'))?'':e.innerText)||'').trim().slice(0,512);
  const resolvedForm=e.form||e.closest('form');
  const actual=JSON.stringify([e.tagName,e.getAttribute('type'),e.getAttribute('name'),name,e.getAttribute('href'),e.getAttribute('formaction'),e.getAttribute('action'),resolvedForm?.getAttribute('action'),e.disabled,resolvedForm?.getAttribute('method'),resolvedForm?.getAttribute('target'),resolvedForm?.getAttribute('enctype'),e.getAttribute('form'),e.getAttribute('formtarget'),e.getAttribute('formmethod'),e.getAttribute('formenctype')]);
  if(actual!==${JSON.stringify(fingerprint)})return null;
  const sensitive=/password|token|secret|api.?key|credential|otp|one-time-code|current-password|new-password|cvv|card|ssn/i.test([e.getAttribute('name'),e.getAttribute('id'),e.getAttribute('autocomplete'),name].join(' '));
  if(['password','hidden','file'].includes(e.type)||sensitive||resolvedForm?.querySelector('input[type=password],input[type=file]'))return null;
  ${action?.kind === 'click' ? 'HTMLElement.prototype.click.call(e);' : action?.kind === 'fill' ? `if(!['INPUT','TEXTAREA'].includes(e.tagName))return null;e.value=${JSON.stringify(action.text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));` : action?.kind === 'select' ? `if(e.tagName!=='SELECT'||![...e.options].some(o=>o.value===${JSON.stringify(action.value)}))return null;e.value=${JSON.stringify(action.value)};e.dispatchEvent(new Event('change',{bubbles:true}));` : action?.kind === 'press' ? `
    if(${JSON.stringify(action.key)}==='Enter'&&e.matches('button,a,input[type=button],input[type=submit]')){HTMLElement.prototype.click.call(e);return {valid:true,handled:true,tag:e.tagName};}
    if(${JSON.stringify(action.key)}==='Space'&&e.matches('button,a,input[type=button],input[type=submit]')){HTMLElement.prototype.click.call(e);return {valid:true,handled:true,tag:e.tagName};}
    const form=e.form||e.closest('form');
    if(${JSON.stringify(action.key)}==='Enter'&&e.matches('input:not([type=button]):not([type=submit])')&&form){
      if(form!==globalThis.__foundryBrowserForms?.[${Number(id) - 1}]||!form.isConnected)return null;
      HTMLFormElement.prototype.requestSubmit.call(form);return {valid:true,handled:true,tag:e.tagName};
    }
    const key=${JSON.stringify(action.key === 'Space' ? ' ' : action.key)};
    e.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
    e.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true,cancelable:true}));
    ` : ''}
  return {valid:true,tag:e.tagName,type:e.type||'',name:name.slice(0,160)};
})()`;

export class BrowserManager {
  private readonly profile = session.fromPartition(PARTITION, { cache: true });
  private readonly tabs = new Map<string, Tab>();
  private readonly prepared = new Map<string, PreparedRecord>();
  private activeId: string | null = null;
  private bounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private hidden = false;
  private stopped = false;

  constructor(private readonly window: BrowserWindow, private readonly onState: (state: BrowserState) => void) {
    this.profile.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
    const attachedSource = (webContentsId?: number): boolean => {
      const attached = [...this.tabs.values()].some(tab => !!tab.taskId || !!tab.attaching);
      if (!attached) return false;
      const source = [...this.tabs.values()].find(tab => tab.contents.id === webContentsId);
      return source ? !!source.taskId || !!source.attaching : true; // Unknown worker requests fail closed while any tab is attached.
    };
    this.profile.webRequest.onBeforeRequest((details, callback) => {
      const upload = details.uploadData?.some(part => !!part.file || !!part.blobUUID) ?? false;
      callback({ cancel: attachedSource(details.webContentsId) && upload });
    });
    this.profile.webRequest.onBeforeSendHeaders((details, callback) => {
      const contentType = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
      const upload = details.uploadData?.some(part => !!part.file || !!part.blobUUID) ?? false;
      callback({ cancel: attachedSource(details.webContentsId) && (upload || /^(?:multipart\/form-data|application\/octet-stream)(?:;|$)/i.test(contentType)) });
    });
    this.profile.on('will-download', (event, item, contents) => {
      const tab = [...this.tabs.values()].find(value => value.contents === contents);
      if (!tab || tab.taskId || tab.attaching || this.stopped) { if (tab?.attaching) tab.attaching.cancelled = true; event.preventDefault(); return; }
      item.pause();
      tab.downloads.add(item);
      item.once('done', () => tab.downloads.delete(item));
      void this.manualDownload(item, tab).catch(() => { if (tab.downloads.has(item)) item.cancel(); });
    });
    this.createTab();
  }

  private async manualDownload(item: DownloadItem, tab: Tab): Promise<void> {
    const result = await dialog.showSaveDialog(this.window, { title: 'Save browser download', defaultPath: item.getFilename() });
    if (result.canceled || !result.filePath || !this.tabs.has(tab.id) || tab.taskId || this.stopped) { item.cancel(); return; }
    item.setSavePath(result.filePath);
    item.resume();
  }

  private createTab(url?: string, popupContents?: WebContents): Tab {
    if (this.tabs.size >= MAX_TABS) throw new BrowserHostError('failed', 'Browser tab limit reached.');
    const view = new WebContentsView({ ...(popupContents ? { webContents: popupContents } : {}), webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const contents = view.webContents;
    const tab: Tab = { id: randomUUID(), view, contents, generation: 0, attachmentId: null, taskId: null, attaching: null, lastTaskId: null, authorizedOrigin: null, pendingOrigin: null, error: null, snapshot: null, fingerprints: new Map(), prepared: new Set(), downloads: new Set(), contextId: null, busy: Promise.resolve() };
    this.tabs.set(tab.id, tab);
    contents.on('destroyed', () => {
      if (this.stopped || !this.tabs.has(tab.id)) return;
      this.closeTab(tab); this.emit();
    });
    contents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (this.tabs.size >= MAX_TABS || tab.attaching) { if (tab.attaching) tab.attaching.cancelled = true; return { action: 'deny' }; }
      try { if (popupUrl !== 'about:blank') safeUrl(popupUrl); } catch { return { action: 'deny' }; }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } },
        createWindow: options => {
          // Electron creates the popup contents with its opener/referrer relationship.
          // Adopting it preserves login flows and avoids leaving an unowned native popup.
          // Electron supplies this field at runtime but omits it from BrowserWindowConstructorOptions.
          const popupContents = (options as { webContents?: WebContents }).webContents;
          const child = this.createTab(popupContents ? undefined : popupUrl, popupContents);
          this.activeId = child.id; this.syncViews(); this.emit(); return child.contents;
        }
      };
    });
    contents.on('will-navigate', (event, destination) => { if (tab.attaching) { tab.attaching.cancelled = true; event.preventDefault(); return; } try { safeUrl(destination); } catch { event.preventDefault(); } this.invalidate(tab); });
    contents.on('will-redirect', (_event, destination, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (tab.attaching) { tab.attaching.cancelled = true; _event.preventDefault(); return; }
      try { safeUrl(destination); } catch { _event.preventDefault(); }
      if (tab.pendingOrigin && originOf(destination) !== tab.pendingOrigin) {
        tab.pendingOrigin = null;
        tab.authorizedOrigin = null;
      }
    });
    contents.on('did-start-navigation', () => { if (tab.attaching) { tab.attaching.cancelled = true; contents.stop(); } this.invalidate(tab); this.emit(); });
    contents.on('did-navigate', () => {
      this.invalidate(tab);
      if (tab.pendingOrigin && originOf(contents.getURL()) !== tab.pendingOrigin) {
        tab.pendingOrigin = null;
        tab.authorizedOrigin = null;
      }
      this.emit();
    });
    contents.on('did-navigate-in-page', () => { this.invalidate(tab); this.emit(); });
    contents.on('page-title-updated', () => this.emit());
    contents.on('did-start-loading', () => this.emit());
    contents.on('did-stop-loading', () => this.emit());
    contents.on('did-fail-load', (_event, code, message, validatedURL, mainFrame) => { if (mainFrame && code !== -3) { tab.error = `${message} (${validatedURL})`.slice(0, 1000); this.emit(); } });
    contents.on('render-process-gone', () => { if (this.stopped || !this.tabs.has(tab.id) || contents.isDestroyed()) return; this.detach(tab); tab.error = 'Browser tab crashed.'; this.emit(); });
    contents.debugger.on('detach', () => { if (this.stopped || !this.tabs.has(tab.id) || contents.isDestroyed()) return; this.detach(tab); tab.error = 'Browser automation disconnected.'; this.emit(); });
    contents.debugger.on('message', (_event, method) => {
      if (method !== 'Page.fileChooserOpened') return;
      if (tab.attaching) tab.attaching.cancelled = true;
      if (tab.taskId) { this.detach(tab); this.emit(); }
    });
    contents.on('before-mouse-event', (event, mouse) => {
      if ((tab.taskId || tab.attaching) && !['mouseMove', 'mouseEnter', 'mouseLeave'].includes(mouse.type)) {
        event.preventDefault();
        if (tab.attaching) tab.attaching.cancelled = true;
        this.detach(tab);
        this.emit();
      }
    });
    contents.on('before-input-event', event => {
      if (tab.taskId || tab.attaching) { event.preventDefault(); if (tab.attaching) tab.attaching.cancelled = true; this.detach(tab); this.emit(); }
    });
    if (!this.activeId) this.activeId = tab.id;
    if (url) void contents.loadURL(url).catch(error => { tab.error = String(error).slice(0, 1000); this.emit(); });
    this.syncViews(); this.emit(); return tab;
  }

  private invalidate(tab: Tab): void {
    tab.generation++;
    tab.contextId = null;
    tab.snapshot = null;
    tab.fingerprints.clear();
    for (const id of tab.prepared) this.prepared.delete(id);
    tab.prepared.clear();
    // The old document remains current during provisional navigation. Reads are blocked by
    // isLoading(); retain same-origin sharing only if the committed destination matches.
    if (tab.taskId && tab.authorizedOrigin !== originOf(tab.contents.getURL()) && !tab.pendingOrigin) tab.authorizedOrigin = null;
  }
  private detach(tab: Tab): void {
    if (tab.attaching) tab.attaching.cancelled = true;
    if (tab.contents.isDestroyed()) {
      for (const id of tab.prepared) this.prepared.delete(id);
      tab.prepared.clear();
      tab.snapshot = null;
      tab.fingerprints.clear();
      tab.contextId = null;
    } else this.invalidate(tab);
    for (const item of tab.downloads) item.cancel();
    tab.downloads.clear();
    tab.lastTaskId = tab.taskId ?? tab.lastTaskId;
    tab.taskId = null;
    tab.attachmentId = null;
    tab.authorizedOrigin = null;
    tab.pendingOrigin = null;
    if (!tab.contents.isDestroyed() && tab.contents.debugger.isAttached()) void tab.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
  private metadata(tab: Tab): BrowserTab { const wc = tab.contents; const url = wc.getURL(); return { id: tab.id, title: wc.getTitle().slice(0, 512), url: url.slice(0, 8192), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), generation: tab.generation, attachedTaskId: tab.taskId, authorizedOrigin: tab.authorizedOrigin, sharing: !!tab.taskId && !tab.attaching && tab.authorizedOrigin === originOf(url), error: tab.error }; }
  private state(): BrowserState { return { tabs: [...this.tabs.values()].map(tab => this.metadata(tab)), activeTabId: this.activeId }; }
  private emit(): void { if (!this.stopped) this.onState(this.state()); }
  private required(id: string): Tab { const tab = this.tabs.get(id); if (!tab) throw new BrowserHostError('stale', 'Browser tab no longer exists.'); return tab; }
  private attached(taskId: string, tabId: string, sharing = true): Tab {
    const tab = this.required(tabId);
    if (tab.taskId !== taskId || !tab.attachmentId || tab.attaching || (sharing && (tab.contents.isLoading() || tab.authorizedOrigin !== originOf(tab.contents.getURL())))) {
      throw new BrowserHostError('stale', 'The tab is not shared with this chat at its current origin.');
    }
    return tab;
  }
  private syncViews(): void { if (this.window.isDestroyed()) return; for (const tab of this.tabs.values()) { const show = !this.hidden && this.bounds.visible && tab.id === this.activeId && this.bounds.width > 0 && this.bounds.height > 0; if (show) { if (!this.window.contentView.children.includes(tab.view)) this.window.contentView.addChildView(tab.view); const [width, height] = this.window.getContentSize(); const w = width ?? 0, h = height ?? 0; const x = Math.max(0, Math.min(this.bounds.x, w)); const y = Math.max(0, Math.min(this.bounds.y, h)); tab.view.setBounds({ x, y, width: Math.max(0, Math.min(this.bounds.width, w - x)), height: Math.max(0, Math.min(this.bounds.height, h - y)) }); } else if (this.window.contentView.children.includes(tab.view)) this.window.contentView.removeChildView(tab.view); } }
  hide(): void { this.hidden = true; this.syncViews(); }
  restore(): void { this.hidden = false; this.syncViews(); }

  async command(input: BrowserCommand): Promise<BrowserState> {
    const command = BrowserCommandSchema.parse(input);
    if (this.stopped) throw new BrowserHostError('failed', 'Browser is shutting down.');
    if (command.kind === 'state') return this.state();
    if (command.kind === 'create') {
      const tab = this.createTab();
      this.activeId = tab.id;
      this.syncViews();
    }
    else if (command.kind === 'bounds') { this.bounds = command.bounds; this.hidden = false; this.syncViews(); }
    else if (command.kind === 'clearProfile') await this.clearProfile();
    else {
      const tab = this.required(command.tabId);
      if (command.kind === 'activate') { this.activeId = tab.id; this.syncViews(); }
      else if (command.kind === 'close') this.closeTab(tab);
      else if (command.kind === 'takeControl') this.detach(tab);
      else if (command.kind === 'attach') {
        if (tab.attaching) throw new BrowserHostError('stale', 'Attachment is already in progress.');
        const guard = { id: randomUUID(), taskId: command.taskId, cancelled: false };
        const generation = tab.generation;
        const url = tab.contents.getURL();
        tab.attaching = guard;
        try {
          if (tab.contents.isLoading()) throw new BrowserHostError('stale', 'Wait for the page to finish loading before attaching.');
          const debuggerApi = tab.contents.debugger;
          if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
          await debuggerApi.sendCommand('Page.enable');
          await debuggerApi.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
          if (guard.cancelled) throw new BrowserHostError('stale', 'Page interaction interrupted attachment. Retry in manual control.');
          if (await this.checkSelectedFilesWithTimeout(tab)) {
            throw new BrowserHostError('failed', 'Finish upload or reload in manual control before attaching.');
          }
          if (guard.cancelled || tab.attaching !== guard || !this.tabs.has(tab.id) || tab.contents.isDestroyed() || tab.contents.isLoading() || tab.generation !== generation || tab.contents.getURL() !== url) {
            throw new BrowserHostError('stale', 'Page changed during attachment. Retry when it finishes loading.');
          }
          this.invalidate(tab);
          for (const item of tab.downloads) item.cancel();
          tab.downloads.clear();
          tab.taskId = command.taskId;
          tab.lastTaskId = command.taskId;
          tab.attachmentId = randomUUID();
          tab.authorizedOrigin = originOf(tab.contents.getURL());
          tab.attaching = null;
        } catch (error) {
          this.detach(tab);
          if (error instanceof BrowserHostError) throw error;
          throw new BrowserHostError('failed', 'Browser automation is unavailable.');
        } finally {
          if (tab.attaching === guard) tab.attaching = null;
          if (!tab.taskId && !tab.contents.isDestroyed() && tab.contents.debugger.isAttached()) {
            await tab.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
          }
        }
      }
      else if (command.kind === 'clearSite') await this.clearSite(tab);
      else {
        this.detach(tab);
        if (command.kind === 'navigate') {
          void tab.contents.loadURL(safeUrl(command.url)).catch(error => {
            if (!String(error).includes('ERR_ABORTED')) tab.error = String(error).slice(0, 1000);
            this.emit();
          });
        } else if (command.kind === 'back' && tab.contents.navigationHistory.canGoBack()) tab.contents.navigationHistory.goBack();
        else if (command.kind === 'forward' && tab.contents.navigationHistory.canGoForward()) tab.contents.navigationHistory.goForward();
        else if (command.kind === 'reload') tab.contents.reload();
        else if (command.kind === 'stop') tab.contents.stop();
      }
    }
    this.emit(); return this.state();
  }

  private closeTab(tab: Tab): void { this.detach(tab); this.tabs.delete(tab.id); if (!this.window.isDestroyed() && this.window.contentView.children.includes(tab.view)) this.window.contentView.removeChildView(tab.view); if (!tab.contents.isDestroyed()) tab.contents.close(); if (this.activeId === tab.id) this.activeId = this.tabs.keys().next().value ?? null; if (!this.activeId && !this.stopped && !this.window.isDestroyed()) this.createTab(); this.syncViews(); }
  private async clearSite(tab: Tab): Promise<void> { const origin = originOf(tab.contents.getURL()); if (origin === 'null') throw new BrowserHostError('failed', 'Open a website before clearing its data.'); for (const candidate of this.tabs.values()) if (originOf(candidate.contents.getURL()) === origin) { this.detach(candidate); candidate.contents.stop(); await candidate.contents.loadURL('about:blank'); } await this.profile.clearStorageData({ origin, storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'] }); await this.profile.clearCache(); await this.profile.cookies.flushStore(); await this.profile.flushStorageData(); }
  private async clearProfile(): Promise<void> { for (const tab of this.tabs.values()) { this.detach(tab); tab.contents.stop(); await tab.contents.loadURL('about:blank'); } await this.profile.clearStorageData(); await this.profile.clearCache(); await this.profile.cookies.flushStore(); await this.profile.flushStorageData(); }

  private async evaluate(tab: Tab, expression: string): Promise<unknown> { const debuggerApi = tab.contents.debugger; if (!debuggerApi.isAttached()) debuggerApi.attach('1.3'); if (tab.contextId === null) { const tree = await debuggerApi.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }; const world = await debuggerApi.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'Foundry Browser Host', grantUniveralAccess: false }) as { executionContextId: number }; tab.contextId = world.executionContextId; } const result = await debuggerApi.sendCommand('Runtime.evaluate', { expression, contextId: tab.contextId, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown }; if (result.exceptionDetails) throw new BrowserHostError('failed', 'Page evaluation failed.'); return result.result?.value; }
  private async hasSelectedFiles(tab: Tab): Promise<boolean> {
    const debuggerApi = tab.contents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    await debuggerApi.sendCommand('Page.enable');
    type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
    const { frameTree } = await debuggerApi.sendCommand('Page.getFrameTree') as { frameTree: FrameTree };
    const frames: FrameTree[] = [frameTree];
    let inspected = 0;
    while (frames.length) {
      if (++inspected > MAX_CHECKED_FRAMES || inspected + frames.length > MAX_CHECKED_FRAMES) throw new BrowserHostError('failed', 'Too many page frames to verify file selections. Reload in manual control before attaching.');
      const frame = frames.shift()!;
      frames.push(...(frame.childFrames ?? []));
      const { executionContextId } = await debuggerApi.sendCommand('Page.createIsolatedWorld', { frameId: frame.frame.id, worldName: 'Foundry Browser File Check', grantUniveralAccess: false }) as { executionContextId: number };
      const result = await debuggerApi.sendCommand('Runtime.evaluate', { expression: `[...document.querySelectorAll('input[type=file]')].some(input => input.files?.length>0)`, contextId: executionContextId, returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (result.exceptionDetails || result.result?.value !== false) return true;
    }
    return false;
  }
  private async checkSelectedFilesWithTimeout(tab: Tab): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.hasSelectedFiles(tab),
        new Promise<boolean>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BrowserHostError('failed', 'File selection check timed out. Reload in manual control before attaching.')), FILE_CHECK_TIMEOUT_MS);
        })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async snapshot(tab: Tab): Promise<BrowserSnapshot> { const before = tab.generation; const origin = originOf(tab.contents.getURL()); if (tab.authorizedOrigin !== origin) throw new BrowserHostError('stale', 'Page origin changed. Reattach the tab.'); const result = await this.evaluate(tab, SNAPSHOT_SCRIPT) as { text?: string; nodes?: Array<{ id: string; role: string; name: string; fingerprint: string }>; truncated?: boolean } | undefined; if (before !== tab.generation || origin !== originOf(tab.contents.getURL())) throw new BrowserHostError('stale', 'Page changed during the read.'); for (const id of tab.prepared) this.prepared.delete(id); tab.prepared.clear(); const nodes = (result?.nodes ?? []).slice(0, 300); const value: BrowserSnapshot = { id: randomUUID(), tabId: tab.id, generation: before, origin, url: tab.contents.getURL().slice(0, 8192), text: (result?.text ?? '').slice(0, 48000), nodes: nodes.map(({ id, role, name }) => ({ id, role, name })), truncated: !!result?.truncated }; tab.snapshot = value; tab.fingerprints = new Map(nodes.map(node => [node.id, node.fingerprint])); return value; }
  private async withTab<T>(tab: Tab, work: () => Promise<T>): Promise<T> { const previous = tab.busy; let release!: () => void; tab.busy = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
  async request(input: BrowserHostRequest): Promise<BrowserHostResult> {
    const request = BrowserHostRequestSchema.parse(input);
    if (this.stopped) throw new BrowserHostError('failed', 'Browser is shutting down.');
    if (request.kind === 'tabs') return [...this.tabs.values()].filter(tab => tab.taskId === request.taskId).map(tab => this.metadata(tab));
    if (request.kind === 'revoke') {
      for (const tab of this.tabs.values()) {
        if (tab.taskId === request.taskId) this.detach(tab);
        else if (tab.attaching?.taskId === request.taskId) tab.attaching.cancelled = true;
      }
      this.emit(); return null;
    }
    if (request.kind === 'inspect') { const tab = this.required(request.tabId); if (tab.taskId !== request.taskId && tab.lastTaskId !== request.taskId) throw new BrowserHostError('stale', 'Tab does not belong to this chat.'); return { tabId: tab.id, generation: tab.generation, origin: originOf(tab.contents.getURL()), inspectedAt: new Date().toISOString() }; }
    const tab = this.attached(request.taskId, request.kind === 'snapshot' ? request.tabId : request.kind === 'prepare' ? request.action.tabId : this.prepared.get(request.preparedId)?.value.tabId ?? '');
    return this.withTab(tab, async () => {
      this.attached(request.taskId, tab.id);
      if (request.kind === 'snapshot') return this.snapshot(tab);
      if (request.kind === 'prepare') {
        const action = BrowserActionSchema.parse(request.action);
        let fingerprint: string | undefined;
        if (action.kind !== 'navigate') { if (!tab.snapshot || tab.snapshot.id !== action.snapshotId || tab.snapshot.generation !== tab.generation) throw new BrowserHostError('stale', 'Read the current page before acting.'); if ('nodeId' in action) { fingerprint = tab.fingerprints.get(action.nodeId); if (!fingerprint) throw new BrowserHostError('stale', 'Target no longer exists.'); const actual = await this.evaluate(tab, TARGET_SCRIPT(action.nodeId, fingerprint)) as { valid?: boolean; type?: string; tag?: string } | null; if (!actual?.valid) throw new BrowserHostError('stale', 'Target changed or cannot be used by an agent.'); if (action.kind === 'fill' && !['INPUT', 'TEXTAREA'].includes(actual.tag ?? '')) throw new BrowserHostError('failed', 'Fill requires a text field.'); if (action.kind === 'select' && actual.tag !== 'SELECT') throw new BrowserHostError('failed', 'Select requires a list.'); } }
        if (tab.prepared.size >= MAX_PREPARED_PER_TAB) throw new BrowserHostError('failed', 'Too many pending browser actions. Resolve or refresh the page before preparing more.');
        const prepared: BrowserPrepared = { id: randomUUID(), taskId: request.taskId, tabId: tab.id, attachmentId: tab.attachmentId!, generation: tab.generation, origin: originOf(tab.contents.getURL()), action, summary: describe(action, tab).slice(0, 6000), createdAt: new Date().toISOString() };
        this.prepared.set(prepared.id, { value: prepared, fingerprint, consumed: false }); tab.prepared.add(prepared.id); return prepared;
      }
      const record = this.prepared.get(request.preparedId);
      if (!record || record.consumed || record.value.taskId !== request.taskId || record.value.attachmentId !== tab.attachmentId || record.value.generation !== tab.generation || record.value.origin !== originOf(tab.contents.getURL()) || Date.now() - Date.parse(record.value.createdAt) > PREPARED_TTL_MS) throw new BrowserHostError('stale', 'Approval target changed or expired.');
      const action = record.value.action;
      record.consumed = true; this.prepared.delete(record.value.id); tab.prepared.delete(record.value.id);
      try {
        if (action.kind === 'navigate') {
          const destinationOrigin = originOf(action.url);
          tab.pendingOrigin = destinationOrigin;
          tab.authorizedOrigin = destinationOrigin;
          try { await tab.contents.loadURL(safeUrl(action.url)); }
          catch (error) { tab.pendingOrigin = null; tab.authorizedOrigin = null; throw error; }
          tab.authorizedOrigin = tab.pendingOrigin === destinationOrigin && originOf(tab.contents.getURL()) === destinationOrigin ? destinationOrigin : null;
          tab.pendingOrigin = null;
        }
        else if (action.kind === 'scroll') await this.evaluate(tab, `window.scrollBy(0,${action.direction === 'up' ? -action.pixels : action.pixels})`);
        else {
          const result = await this.evaluate(tab, TARGET_SCRIPT(action.nodeId, record.fingerprint!, action)) as { valid?: boolean } | null;
          if (!result?.valid) throw new BrowserHostError('stale', 'Target changed before dispatch.');
        }
      } catch (error) { if (error instanceof BrowserHostError && error.code === 'stale') throw error; throw new BrowserHostError('unknown', 'Browser action was dispatched but its result is unknown. Inspect the tab before another action.'); }
      this.invalidate(tab); this.emit(); return { status: 'dispatched', detail: record.value.summary.slice(0, 4000) };
    });
  }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    await this.profile.cookies.flushStore();
    await this.profile.flushStorageData();
  }
}
