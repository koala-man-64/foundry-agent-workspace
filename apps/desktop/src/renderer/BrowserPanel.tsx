import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserCommand, BrowserState, BrowserTab, DesktopApi } from '../../../../packages/protocol/src/index';

type Confirmation = 'attach' | 'clearSite' | 'clearProfile' | null;
const emptyState: BrowserState = { tabs: [], activeTabId: null };

export function normalizeBrowserAddress(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('Enter a website address.');
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    if (!local && /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[a-z][a-z\d+.-]*:\d+(?:[/?#]|$)/i.test(input)) throw new Error('Only HTTP and HTTPS websites can be opened.');
  }
  const address = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `${local ? 'http' : 'https'}://${input}`;
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error('Enter an HTTP or HTTPS website without credentials in the address.');
  }
  return url.href;
}

interface Props {
  api: DesktopApi;
  taskId?: string;
  profileName?: string;
  eligible: boolean;
  hidden: boolean;
  onNotice(message: string): void;
}

export function BrowserPanel({ api, taskId, profileName, eligible, hidden, onNotice }: Props) {
  const [state, setState] = useState<BrowserState>(emptyState);
  const [address, setAddress] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [busy, setBusy] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const boundsRef = useRef('');
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  const tabId = tab?.id;

  useEffect(() => {
    let alive = true;
    const dispose = api.onBrowserState((next) => { if (alive) setState(next); });
    void api.browser({ kind: 'state' }).then((next) => { if (alive) setState(next); }).catch((error) => onNotice(`Browser unavailable: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      alive = false;
      dispose();
      void api.browser({ kind: 'bounds', bounds: { x: 0, y: 0, width: 0, height: 0, visible: false } }).catch(() => undefined);
    };
  }, [api, onNotice]);

  useEffect(() => { if (!editingAddress) setAddress(tab?.url ?? ''); }, [tab?.url, tabId, editingAddress]);
  useEffect(() => { setConfirmation(null); }, [tabId, taskId]);

  const sendBounds = useCallback(() => {
    const element = contentRef.current;
    const rectangle = element?.getBoundingClientRect();
    const x = rectangle ? Math.max(0, Math.ceil(rectangle.left)) : 0;
    const y = rectangle ? Math.max(0, Math.ceil(rectangle.top)) : 0;
    const right = rectangle ? Math.min(window.innerWidth, Math.floor(rectangle.right)) : 0;
    const bottom = rectangle ? Math.min(window.innerHeight, Math.floor(rectangle.bottom)) : 0;
    const bounds = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y), visible: !hidden && !confirmation && Boolean(tabId) && right > x && bottom > y };
    const key = JSON.stringify(bounds);
    if (key === boundsRef.current) return;
    boundsRef.current = key;
    void api.browser({ kind: 'bounds', bounds }).catch((error) => onNotice(`Could not position browser page: ${error instanceof Error ? error.message : String(error)}`));
  }, [api, confirmation, hidden, onNotice, tabId]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    const observer = new ResizeObserver(sendBounds);
    if (element) observer.observe(element);
    window.addEventListener('resize', sendBounds);
    sendBounds();
    return () => { observer.disconnect(); window.removeEventListener('resize', sendBounds); };
  }, [sendBounds]);

  const command = async (input: BrowserCommand) => {
    if (busy) return;
    setBusy(true);
    try { setState(await api.browser(input)); }
    catch (error) { onNotice(`Browser: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (!tab || !address.trim()) return;
    try { void command({ kind: 'navigate', tabId: tab.id, url: normalizeBrowserAddress(address) }); setEditingAddress(false); }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
  };
  const confirm = () => {
    if (confirmation === 'attach' && tab && taskId) void command({ kind: 'attach', tabId: tab.id, taskId });
    if (confirmation === 'clearSite' && tab) void command({ kind: 'clearSite', tabId: tab.id, confirm: 'clear-site' });
    if (confirmation === 'clearProfile') void command({ kind: 'clearProfile', confirm: 'clear-profile' });
    setConfirmation(null);
  };
  const attached = Boolean(tab?.attachedTaskId);
  const ownAttachment = Boolean(taskId && tab?.attachedTaskId === taskId);
  const manual = !attached;
  const attachedToOther = attached && !ownAttachment;

  return <section className="browser-panel" aria-label="Integrated browser">
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
      {state.tabs.map((item: BrowserTab) => <div key={item.id} className={`browser-tab ${item.id === tabId ? 'active' : ''}`}>
        <button type="button" role="tab" aria-selected={item.id === tabId} title={item.title || item.url || 'New tab'} onClick={() => void command({ kind: 'activate', tabId: item.id })}>{item.loading ? '◌ ' : ''}{item.title || item.url || 'New tab'}{item.attachedTaskId ? ' · attached' : ''}</button>
        <button type="button" className="browser-tab-close" aria-label={`Close ${item.title || 'tab'}`} onClick={() => void command({ kind: 'close', tabId: item.id })}>×</button>
      </div>)}
      <button type="button" className="browser-new-tab" title="New tab" aria-label="New browser tab" disabled={busy || state.tabs.length >= 20} onClick={() => void command({ kind: 'create' })}>+</button>
    </div>
    <div className="browser-navigation">
      <button type="button" aria-label="Back" disabled={!manual || !tab?.canGoBack || busy} onClick={() => tab && void command({ kind: 'back', tabId: tab.id })}>←</button>
      <button type="button" aria-label="Forward" disabled={!manual || !tab?.canGoForward || busy} onClick={() => tab && void command({ kind: 'forward', tabId: tab.id })}>→</button>
      <button type="button" aria-label={tab?.loading ? 'Stop loading' : 'Reload'} disabled={!manual || !tab || busy} onClick={() => tab && void command({ kind: tab.loading ? 'stop' : 'reload', tabId: tab.id })}>{tab?.loading ? '×' : '↻'}</button>
      <form onSubmit={navigate}><input aria-label="Website address" value={address} onFocus={() => setEditingAddress(true)} onBlur={() => setEditingAddress(false)} onChange={(event) => setAddress(event.target.value)} placeholder="Enter a website address" disabled={!manual || !tab || busy} /><button type="submit" disabled={!manual || !tab || busy}>Go</button></form>
    </div>
    <div className="browser-access">
      {attached ? <><span className="browser-attachment">{ownAttachment ? 'Attached to this chat' : 'Attached to another chat'}{tab?.sharing ? ' · page shared' : ' · sharing paused'}</span><button type="button" disabled={busy} onClick={() => tab && void command({ kind: 'takeControl', tabId: tab.id })}>Take control</button></> : <><span>Manual browsing · uploads and downloads stay in your control</span><button type="button" disabled={!tab || !taskId || !eligible || busy} onClick={() => setConfirmation('attach')}>Attach to chat…</button></>}
    </div>
    {tab?.error && <p className="browser-error" role="alert">{tab.error}</p>}
    {attachedToOther && <p className="browser-hint">Take control to stop sharing with the other chat before using this tab.</p>}
    {!eligible && taskId && <p className="browser-hint">This chat needs a verified tool-capable model profile before browser attachment.</p>}
    <div className="browser-content" ref={contentRef}>{!tab && <div className="browser-blank"><h2>Browse the web</h2><p>Open a tab to start. Website sign-ins and storage persist in this app’s browser profile.</p><button type="button" className="secondary" disabled={busy || state.tabs.length >= 20} onClick={() => void command({ kind: 'create' })}>Open tab</button></div>}{tab && !tab.url && <div className="browser-blank"><h2>New tab</h2><p>Enter a website address above.</p></div>}</div>
    <div className="browser-data-actions"><button type="button" disabled={!manual || !tab?.url || busy} onClick={() => setConfirmation('clearSite')}>Clear site data…</button><button type="button" disabled={attached || busy} onClick={() => setConfirmation('clearProfile')}>Clear browser data…</button></div>
    {confirmation && <div className="browser-confirm" role="dialog" aria-modal="true" aria-label="Confirm browser action">
      <h2>{confirmation === 'attach' ? 'Attach this tab to the chat?' : confirmation === 'clearSite' ? 'Clear this site’s data?' : 'Clear all browser data?'}</h2>
      <p>{confirmation === 'attach' ? `Visible page content from this tab can be sent to ${profileName || 'this chat’s configured model'}. Every agent interaction still needs your approval. Sign-in and file transfers require manual control.` : confirmation === 'clearSite' ? `This removes cookies and website storage for ${tab?.url ? new URL(tab.url).origin : 'this site'}. The site may sign you out. Your chats and model credentials remain.` : 'This removes cookies and website storage for all sites in the app browser profile. Websites may sign you out. Your chats and model credentials remain.'}</p>
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className={confirmation === 'attach' ? 'primary' : 'danger'} disabled={busy} onClick={confirm}>{confirmation === 'attach' ? 'Attach tab' : 'Clear data'}</button></div>
    </div>}
  </section>;
}
