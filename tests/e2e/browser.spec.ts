import { test, expect as baseExpect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserState } from '../../packages/protocol/src/index';
const expect = baseExpect.configure({ timeout: 30000 });

const HTML = `<!doctype html><html><head><title>Browser fixture</title></head><body>
<h1>Browser fixture</h1><button onclick="document.querySelector('#result').textContent='Approved click ran'">Browser demo action</button>
<p id="result">No action yet</p><input aria-label="Public text"><input type="password" value="private-password-canary"><input type="hidden" value="hidden-canary">
<a href="/next">Next page</a><button onclick="window.open('/popup')">Open login popup</button><form action="/upload" method="post" enctype="multipart/form-data"><input type="file" name="fixture" aria-label="Upload"><button>Upload file</button></form>
<script>
const seed=location.pathname==='/seed';
if(seed) localStorage.setItem('fixture-value','persisted');
window.storageReady=new Promise((resolve,reject)=>{const r=indexedDB.open('fixture-db',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('values',seed?'readwrite':'readonly');const store=tx.objectStore('values');if(seed)store.put('indexed-persisted','key');const get=store.get('key');get.onsuccess=()=>{window.storedValue=get.result??null;};tx.oncomplete=()=>{db.close();resolve();};};});
</script></body></html>`;

function environment(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'APPDATA', 'HOME']) if (process.env[key]) result[key] = process.env[key]!;
  result.FOUNDRY_WORKSPACE_TEST_DATA = directory;
  return result;
}
async function launch(directory: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env: environment(directory) });
  app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  app.on('console', message => { if (message.type() === 'error') process.stderr.write(`${message.text()}\n`); });
  const page = await app.firstWindow();
  await expect.poll(() => page.evaluate(() => window.workspace.invoke('workspace.summary', {}))).toMatchObject({ runtime: 'ready' });
  return { app, page };
}
async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/seed') response.setHeader('Set-Cookie', 'fixture-login=remembered; Max-Age=3600; SameSite=Lax; Path=/');
    if (request.url === '/download') { response.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"'); response.end('browser download fixture'); return; }
    if (request.url === '/upload') {
      const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => { response.setHeader('Content-Type', 'text/html'); response.end(Buffer.concat(chunks).toString().includes('manual upload fixture') ? '<p>Manual upload received</p>' : '<p>Upload content missing</p>'); });
      return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end(HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture server address.');
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function state(page: Page): Promise<BrowserState> { return page.evaluate(() => window.workspace.browser({ kind: 'state' })); }
async function startChat(page: Page, title: string): Promise<string> {
  await page.getByLabel('Chat message', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText(`Fake response: ${title}`, { exact: true })).toBeVisible();
  return page.evaluate(async () => (await window.workspace.invoke('workspace.tasks', { visibility: 'all', limit: 50 })).tasks[0]!.id);
}
async function browserValue(app: ElectronApplication, url: string, script: string): Promise<unknown> {
  await expect.poll(() => app.evaluate(({ webContents }, target) => webContents.getAllWebContents().some(item => item.getURL() === target && !item.isLoading()), url)).toBe(true);
  return app.evaluate(async ({ webContents }, input) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === input.url);
    if (!contents) throw new Error('Fixture browser tab is missing.');
    return contents.executeJavaScript(input.script);
  }, { url, script });
}

test('persistent browser storage, blank restart, manual navigation, popup and isolated clear', async () => {
  test.setTimeout(240000);
  const directory = await mkdtemp(join(tmpdir(), 'foundry-browser-persistence-'));
  const { server, base } = await startServer();
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(directory); let { app, page } = running;
    await startChat(page, 'Browser persistence');
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.getByLabel('Website address').fill(`${base}/seed`);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(async () => (await state(page)).tabs[0]?.url).toBe(`${base}/seed`);
    await browserValue(app, `${base}/seed`, 'window.storageReady');
    expect(await browserValue(app, `${base}/seed`, "({node:typeof require,bridge:typeof window.workspace,stored:localStorage.getItem('fixture-value'),indexed:window.storedValue})")).toEqual({ node: 'undefined', bridge: 'undefined', stored: 'persisted', indexed: 'indexed-persisted' });
    await page.getByRole('button', { name: 'Expand browser' }).click();
    await expect(page.getByRole('button', { name: 'Reduce browser' })).toBeVisible();
    await expect(page.locator('.sidebar-shell')).toBeHidden();
    await expect(page.locator('.inspector-resize')).toBeHidden();
    const expandedWindowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize()) as [number, number];
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 768));
    await expect(page.locator('.browser-content')).toBeVisible();
    await expect(page.locator('.inspector-resize')).toBeHidden();
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0], size[1]), expandedWindowSize);
    await page.getByRole('button', { name: 'Reduce browser' }).click();
    await expect(page.locator('.sidebar-shell')).toBeVisible();
    const originalWindowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize()) as [number, number];
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1024, 768));
    const browserContent = page.locator('.browser-content');
    const separatorHandle = page.getByRole('separator', { name: 'Resize inspector' });
    const initialWidth = (await browserContent.boundingBox())!.width;
    let separator = (await separatorHandle.boundingBox())!;
    await page.mouse.move(separator.x + 2, separator.y + 30); await page.mouse.down();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.slice(1).every(view => !view.getVisible()))).toBe(true);
    await page.mouse.move(separator.x + 70, separator.y + 30, { steps: 4 }); await page.mouse.up();
    await expect.poll(async () => (await browserContent.boundingBox())!.width).toBeLessThan(initialWidth - 20);
    const smallerWidth = (await browserContent.boundingBox())!.width;
    separator = (await separatorHandle.boundingBox())!;
    await page.mouse.move(separator.x + 2, separator.y + 30); await page.mouse.down();
    await page.mouse.move(separator.x - 70, separator.y + 30, { steps: 4 }); await page.mouse.up();
    await expect.poll(async () => (await browserContent.boundingBox())!.width).toBeGreaterThan(smallerWidth + 20);
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0], size[1]), originalWindowSize);
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.slice(1).every(view => !view.getVisible()))).toBe(true);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Manage projects' })).toBeVisible();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.slice(1).every(view => !view.getVisible()))).toBe(true);
    await page.getByRole('dialog', { name: 'Manage projects' }).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /Usage overview/ }).click();
    await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.slice(1).every(view => !view.getVisible()))).toBe(true);
    await page.getByRole('button', { name: /Browser persistence/ }).click();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.setViewportSize({ width: 880, height: 720 });
    await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.slice(1).every(view => !view.getVisible()))).toBe(true);
    await page.setViewportSize({ width: 1480, height: 940 });
    await expect(page.getByLabel('Website address')).toBeVisible();
    const fixturePage = app.context().pages().find(candidate => candidate.url() === `${base}/seed`)!;
    await fixturePage.getByRole('button', { name: 'Open login popup' }).click();
    await expect.poll(async () => (await state(page)).tabs.length).toBe(2);
    await expect.poll(async () => (await state(page)).tabs.some(tab => tab.url === `${base}/popup` && !tab.loading)).toBe(true);
    const popup = (await state(page)).tabs.find(tab => tab.url === `${base}/popup`)!;
    expect(popup.attachedTaskId).toBeNull();
    expect(await browserValue(app, `${base}/popup`, 'document.cookie')).toContain('fixture-login=remembered');
    await browserValue(app, `${base}/popup`, 'setTimeout(() => window.close(), 0); true');
    await expect.poll(async () => (await state(page)).tabs.length).toBe(1);
    await app.close(); running = undefined;
    running = await launch(directory); ({ app, page } = running);
    await page.getByRole('button', { name: /Browser persistence/ }).click();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const fresh = await state(page);
    expect(fresh.tabs).toHaveLength(1); expect(['', 'about:blank']).toContain(fresh.tabs[0]!.url); expect(fresh.tabs[0]!.attachedTaskId).toBeNull();
    await page.getByLabel('Website address').fill(`${base}/read`); await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(async () => (await state(page)).tabs.some(tab => tab.url === `${base}/read` && !tab.loading)).toBe(true);
    await expect.poll(async () => (await state(page)).tabs[0]?.url).toBe(`${base}/read`);
    await browserValue(app, `${base}/read`, 'window.storageReady');
    expect(await browserValue(app, `${base}/read`, "({cookie:document.cookie,stored:localStorage.getItem('fixture-value'),indexed:window.storedValue})")).toEqual({ cookie: 'fixture-login=remembered', stored: 'persisted', indexed: 'indexed-persisted' });
    await page.getByRole('button', { name: 'Clear site data…', exact: true }).click();
    await page.getByRole('button', { name: 'Clear data', exact: true }).click();
    await expect.poll(async () => (await state(page)).tabs.every(tab => !tab.attachedTaskId)).toBe(true);
    const current = (await state(page)).activeTabId!;
    await page.evaluate(input => window.workspace.browser({ kind: 'navigate', tabId: input.id, url: input.url }), { id: current, url: `${base}/read` });
    await browserValue(app, `${base}/read`, 'window.storageReady');
    expect(await browserValue(app, `${base}/read`, "({cookie:document.cookie,stored:localStorage.getItem('fixture-value'),indexed:window.storedValue})")).toEqual({ cookie: '', stored: null, indexed: null });
    expect(await page.evaluate(() => window.workspace.invoke('workspace.summary', {}))).toMatchObject({ runtime: 'ready' });
  } finally { await running?.app.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('ordinary chat reads an attached page and executes only the approved browser action', async () => {
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), 'foundry-browser-approval-'));
  const { server, base } = await startServer();
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(join(directory, 'state')); const { app, page } = running;
    const taskId = await startChat(page, 'Browser chat');
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.getByLabel('Website address').fill(`${base}/read`); await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(async () => (await state(page)).tabs.some(tab => tab.url === `${base}/read` && !tab.loading)).toBe(true);
    const tabId = (await state(page)).activeTabId!;
    const uploadPath = join(directory, 'manual-upload.txt'); await writeFile(uploadPath, 'manual upload fixture');
    const fixturePage = app.context().pages().find(candidate => candidate.url() === `${base}/read`)!;
    const chooserPromise = fixturePage.waitForEvent('filechooser');
    await fixturePage.getByLabel('Upload', { exact: true }).click();
    await (await chooserPromise).setFiles(uploadPath);
    await expect(page.evaluate(input => window.workspace.browser({ kind: 'attach', tabId: input.tabId, taskId: input.taskId }), { tabId, taskId })).rejects.toThrow(/Finish upload or reload/);
    expect((await state(page)).tabs[0]?.attachedTaskId).toBeNull();
    await fixturePage.getByRole('button', { name: 'Upload file', exact: true }).click();
    await expect(fixturePage.getByText('Manual upload received')).toBeVisible();
    await page.evaluate(input => window.workspace.browser({ kind: 'navigate', tabId: input.tabId, url: input.url }), { tabId, url: `${base}/read` });
    await expect.poll(async () => (await state(page)).tabs.some(tab => tab.url === `${base}/read` && !tab.loading)).toBe(true);
    await page.getByRole('button', { name: 'Attach to chat…' }).click(); await page.getByRole('button', { name: 'Attach tab', exact: true }).click();
    await expect(page.getByText('Attached to this chat · page shared')).toBeVisible();
    await page.getByLabel('Task message').fill('/browser-demo'); await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => {
      const detail = await page.evaluate(async id => { const read = await window.workspace.invoke('task.read', { taskId: id }); const summaries = await window.workspace.invoke('task.approvals', { taskId: id }); const approvals = await Promise.all(summaries.approvals.map(async item => (await window.workspace.invoke('approval.get', { taskId: id, approvalId: item.id })).approval)); return { ...read, approvals }; }, taskId);
      return detail.approvals?.find(approval => approval.browser)?.state;
    }).toBe('awaiting-approval');
    expect(await browserValue(app, `${base}/read`, "document.querySelector('#result').textContent")).toBe('No action yet');
    await page.getByRole('button', { name: /^Approvals/ }).click();
    await expect(page.getByText(/Browser demo action/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => browserValue(app, `${base}/read`, "document.querySelector('#result').textContent")).toBe('Approved click ran');
    await expect(page.getByText(/Offline browser demo finished:/)).toBeVisible();
    const detail = await page.evaluate(async id => { const read = await window.workspace.invoke('task.read', { taskId: id }); const summaries = await window.workspace.invoke('task.approvals', { taskId: id }); const approvals = await Promise.all(summaries.approvals.map(async item => (await window.workspace.invoke('approval.get', { taskId: id, approvalId: item.id })).approval)); return { ...read, approvals }; }, taskId);
    expect(detail.approvals?.filter(approval => approval.browser)).toHaveLength(1);
    expect(detail.approvals?.find(approval => approval.browser)?.state).toBe('complete');
    expect(detail.task.mode).toBe('chat');
    expect(detail.task.workspaceKind).toBe('none');
    expect(detail.task.worktreePath).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain('private-password-canary');
    expect(JSON.stringify(detail)).not.toContain('hidden-canary');
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    expect((await state(page)).tabs.every(tab => !tab.attachedTaskId)).toBe(true);
    const destination = join(directory, 'selected-download.txt');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    await browserValue(app, `${base}/read`, "(() => { const link=document.createElement('a'); link.href='/download'; document.body.append(link); link.click(); })()");
    await expect.poll(async () => readFile(destination, 'utf8').catch(() => '')).toBe('browser download fixture');
    await page.evaluate(() => window.workspace.browser({ kind: 'clearProfile', confirm: 'clear-profile' }));
    expect((await page.evaluate(() => window.workspace.invoke('workspace.tasks', { visibility: 'all', limit: 50 }))).tasks.some(task => task.id === taskId)).toBe(true);
  } finally { await running?.app.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
