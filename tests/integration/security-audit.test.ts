/**
 * Phase 05 Workstream A — security, IPC and canary audit.
 *
 * Four boundaries are exercised against the real implementations, not stand-ins:
 *  1. the main process `authorize(event)` gate in front of every privileged IPC channel,
 *  2. Windows-specific path normalization and worktree containment in `RepositoryService`,
 *     the runtime file tools and `CommandRunner`,
 *  3. credential screening from every ingress (stream, tool call, MCP stdout/stderr, exception)
 *     to every egress (SQLite and its WAL, diagnostics bundles, the renderer event stream),
 *  4. Job Object reclamation of whole process trees by `job-runner.ps1` and `mcp-host.ps1`.
 *
 * The Electron module is the only stand-in: it is replaced so that `apps/desktop/src/main/index.ts`
 * can be loaded and its real IPC handlers invoked with forged senders and frames.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServerStatus, ProviderAdapter, ProviderEvent, ProviderRequest, Task, TaskDetail, ToolCall, WorkspaceEvent } from '../../packages/protocol/src/index';
import { createProvider } from '../../packages/providers/src/index';
import { CommandRunner } from '../../packages/runtime/src/command-runner';
import { Redactor } from '../../packages/runtime/src/redaction';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

const WINDOWS = process.platform === 'win32';
const FIXTURE_SERVER = resolve('tests/fixtures/mcp-fixture-server.mjs');
const RENDERER_URL = pathToFileURL(resolve('apps/desktop/src/renderer/index.html'));

// ---------------------------------------------------------------- Electron stand-in

const desktop = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const startupErrors: string[] = [];
  const navigation: string[] = [];
  const permissions: boolean[] = [];
  const mainFrame = { url: '' };
  let windowOpen: (() => { action: string }) | undefined;
  const webContents = {
    mainFrame,
    setWindowOpenHandler(handler: () => { action: string }) { windowOpen = handler; },
    on(name: string, handler: (event: { preventDefault(): void }) => void) {
      handler({ preventDefault: () => navigation.push(name) });
    },
    send() { /* renderer event sink */ },
    isDestroyed() { return false; }
  };
  class StandInWindow {
    readonly webContents = webContents;
    removeMenu(): void { /* no menu in the stand-in */ }
    isDestroyed(): boolean { return false; }
    async loadURL(): Promise<void> { /* renderer is not loaded under test */ }
    async loadFile(): Promise<void> { /* renderer is not loaded under test */ }
    show(): void { /* nothing is displayed under test */ }
  }
  return {
    handlers, startupErrors, navigation, permissions, mainFrame, webContents, StandInWindow,
    // Built without imports: this factory is hoisted above the module's own import bindings.
    userData: `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/foundry-ipc-audit-${Date.now()}`,
    openHandler: () => windowOpen
  };
});

vi.mock('electron', () => ({
  app: {
    setName: () => undefined,
    setPath: () => undefined,
    getPath: () => desktop.userData,
    requestSingleInstanceLock: () => true,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isPackaged: false,
    quit: () => undefined
  },
  BrowserWindow: desktop.StandInWindow,
  dialog: {
    showErrorBox: (title: string, detail: string) => { desktop.startupErrors.push(`${title}: ${detail}`); },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { desktop.handlers.set(channel, handler); } },
  session: {
    defaultSession: {
      setPermissionRequestHandler: (handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void) => handler(null, 'media', granted => desktop.permissions.push(granted)),
      setPermissionCheckHandler: (handler: () => boolean) => { desktop.permissions.push(handler()); }
    }
  },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() }
}));

// ---------------------------------------------------------------- shared helpers

const temporaries: string[] = [];
const waitFor = async (check: () => boolean | Promise<boolean>, label = 'condition', timeout = 20_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${label}.`);
};
function alive(pid: number): boolean {
  return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).includes(String(pid));
}
/** The volume's 8.3 alias for an entry, or its long name when short-name generation is off for the volume. */
function shortBaseName(directory: string, longName: string): string {
  try {
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', '/a', directory], { encoding: 'utf8', windowsHide: true });
    for (const line of listing.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      const alias = fields.at(-2);
      if (fields.at(-1) === longName && alias?.includes('~')) return alias;
    }
  } catch { /* short names are unavailable on this volume */ }
  return longName;
}
async function scratch(prefix: string): Promise<string> {
  const created = await fs.mkdtemp(join(tmpdir(), prefix));
  temporaries.push(created);
  return created;
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}
async function gitRepository(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Security audit']);
  git(root, ['config', 'user.email', 'audit@example.invalid']);
  await fs.writeFile(join(root, 'README.md'), '# Audit fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'audit fixture']);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map(entry => fs.rm(entry, { recursive: true, force: true }).catch(() => undefined)));
});

// ================================================================ 1. IPC sender origin

describe('IPC sender origin and subframe rejection', () => {
  const PRIVILEGED = ['workspace:invoke', 'workspace:save-credential', 'workspace:pick-project'] as const;

  beforeAll(async () => {
    await import('../../apps/desktop/src/main/index');
    await waitFor(() => PRIVILEGED.every(channel => desktop.handlers.has(channel)), 'the main process to register its IPC handlers', 10_000);
  });

  /** Arguments that are individually valid, so only `authorize` can be the reason a call is refused. */
  const argumentsFor = (channel: string): unknown[] =>
    channel === 'workspace:invoke' ? ['workspace.snapshot', {}]
      : channel === 'workspace:save-credential' ? [randomUUID(), 'a-credential-value']
        : [];
  const call = (channel: string, sender: unknown, senderFrame: unknown): Promise<unknown> =>
    Promise.resolve().then(() => desktop.handlers.get(channel)!({ sender, senderFrame }, ...argumentsFor(channel)));
  const fromMainFrame = (channel: string, url: string): Promise<unknown> => {
    desktop.mainFrame.url = url;
    return call(channel, desktop.webContents, desktop.mainFrame);
  };

  it('registered every privileged channel behind the same gate', () => {
    expect([...desktop.handlers.keys()].sort()).toEqual([...PRIVILEGED].sort());
    expect(desktop.startupErrors).toEqual([]);
  });

  it('refuses a sender that is not the single trusted window', async () => {
    const foreignContents = { mainFrame: { url: RENDERER_URL.href } };
    for (const channel of PRIVILEGED) {
      await expect(call(channel, foreignContents, foreignContents.mainFrame)).rejects.toThrow('Untrusted IPC sender.');
      await expect(call(channel, undefined, desktop.mainFrame)).rejects.toThrow('Untrusted IPC sender.');
    }
  });

  it('refuses subframes, popups and destroyed frames of the trusted window', async () => {
    // Same webContents, different frame object: an iframe, a popup frame, or a frame that has gone away.
    const subframe = { url: RENDERER_URL.href };
    const popup = { url: `${RENDERER_URL.href}#popup` };
    for (const channel of PRIVILEGED) {
      await expect(call(channel, desktop.webContents, subframe)).rejects.toThrow('Untrusted IPC sender.');
      await expect(call(channel, desktop.webContents, popup)).rejects.toThrow('Untrusted IPC sender.');
      await expect(call(channel, desktop.webContents, null)).rejects.toThrow('Untrusted IPC sender.');
      await expect(call(channel, desktop.webContents, undefined)).rejects.toThrow('Untrusted IPC sender.');
    }
  });

  it('refuses forged origins, foreign protocols and unparsable frame URLs', async () => {
    const samePath = RENDERER_URL.pathname;
    const forged = [
      'http://localhost:5173/index.html',
      'https://attacker.example/index.html',
      pathToFileURL(resolve('apps/desktop/src/renderer/other.html')).href,
      // `origin` is the opaque value "null" for file: and for every non-special scheme alike, so a
      // foreign scheme carrying the renderer's exact path must be separated by the scheme itself.
      `app://${samePath}`,
      `foundry-workspace:/${samePath}`,
      `data:text/html,${samePath}`,
      'about:blank',
      // Unusable frame URLs must fail closed with the gate's own message, not a URL parser error.
      '',
      'not a url',
      '://missing-scheme'
    ];
    for (const channel of PRIVILEGED) {
      for (const url of forged) {
        await expect(fromMainFrame(channel, url)).rejects.toThrow('Untrusted IPC origin.');
      }
    }
  });

  it('admits only the loaded renderer main frame, and still validates what it asks for', async () => {
    desktop.mainFrame.url = RENDERER_URL.href;
    // Passing `authorize` is necessary but never sufficient: the method allowlist rejects anything unknown.
    await expect(call('workspace:invoke', desktop.webContents, desktop.mainFrame)
      .then(() => undefined, (error: Error) => error.message)).resolves.not.toBe('Untrusted IPC sender.');
    await expect(Promise.resolve().then(() => desktop.handlers.get('workspace:invoke')!({ sender: desktop.webContents, senderFrame: desktop.mainFrame }, '__proto__', {})))
      .rejects.toThrow('Unsupported operation.');
    await expect(Promise.resolve().then(() => desktop.handlers.get('workspace:invoke')!({ sender: desktop.webContents, senderFrame: desktop.mainFrame }, 'constructor', {})))
      .rejects.toThrow('Unsupported operation.');
  });

  it('denies new windows, navigation, webview attachment and every permission request', () => {
    expect(desktop.openHandler()?.()).toEqual({ action: 'deny' });
    expect(desktop.navigation).toContain('will-navigate');
    expect(desktop.navigation).toContain('will-attach-webview');
    expect(desktop.permissions.length).toBeGreaterThan(0);
    expect(desktop.permissions.every(granted => granted === false)).toBe(true);
  });
});

// ================================================================ 2. Windows path containment

describe('Windows path normalization and worktree containment', () => {
  let base: string; let root: string; let outside: string; let service: RepositoryService; let readmeHash: string;

  beforeEach(async () => {
    base = await scratch('foundry-path-audit-');
    root = await gitRepository(join(base, 'worktree'));
    outside = join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'escape.txt'), 'outside the worktree\n');
    await fs.mkdir(join(root, 'sub'));
    await fs.writeFile(join(root, 'sub', 'inner.txt'), 'inner\n');
    await fs.writeFile(join(root, 'longfilename-for-alias.txt'), 'aliased content\n');
    await fs.writeFile(join(root, '.env'), 'PLACEHOLDER=fixture\n');
    await fs.symlink(outside, join(root, 'linked'), 'junction');
    service = new RepositoryService(join(base, 'worktrees'));
    readmeHash = (await service.readFile(root, 'README.md')).hash;
  });

  /** Every read and edit entry point must refuse the same vector; one permissive door is enough to lose containment. */
  const refuses = async (relativePath: string, matcher: RegExp): Promise<void> => {
    await expect(service.readFile(root, relativePath)).rejects.toThrow(matcher);
    await expect(service.listFiles(root, relativePath)).rejects.toThrow(matcher);
    await expect(service.search(root, 'anything', relativePath)).rejects.toThrow(matcher);
    await expect(service.prepareEdit(root, relativePath, readmeHash, 'replacement\n')).rejects.toThrow(matcher);
  };

  it('refuses UNC and device-namespace paths on every file entry point', async () => {
    const forbidden = /absolute|forbidden|escapes|relative/i;
    for (const candidate of [
      '\\\\.\\C:\\Windows\\win.ini',
      '\\\\?\\C:\\Windows\\win.ini',
      '\\\\?\\UNC\\server\\share\\secret.txt',
      '\\\\server\\share\\secret.txt',
      '//?/C:/Windows/win.ini',
      '//./C:/Windows/win.ini',
      '//server/share/secret.txt',
      'C:\\Windows\\win.ini',
      'C:/Windows/win.ini',
      '/etc/passwd'
    ]) {
      await refuses(candidate, forbidden);
    }
  });

  it('refuses NTFS alternate data streams in any path segment', async () => {
    for (const candidate of [
      'README.md:stream',
      'README.md:stream:$DATA',
      'notes:bar:$DATA',
      'sub/inner.txt::$DATA',
      'sub:stream/inner.txt',
      '.:$INDEX_ALLOCATION'
    ]) {
      await refuses(candidate, /forbidden/i);
    }
    // The stream suffix must not be reachable through the containment check either.
    await expect(service.readFile(root, 'linked:stream')).rejects.toThrow(/forbidden/i);
  });

  it('refuses trailing spaces and dots and reserved device names', async () => {
    // Windows silently strips a trailing dot or space, so `README.md.` would otherwise open `README.md`
    // while being screened under a different name; reserved names open devices rather than files.
    for (const candidate of ['README.md.', 'README.md ', 'sub./inner.txt', 'sub /inner.txt', 'CON', 'nul.txt', 'com1', 'LPT9.log']) {
      await refuses(candidate, /forbidden/i);
    }
  });

  it('refuses control characters and wildcards at the filesystem boundary', async () => {
    // These are not screened by name: Win32 rejects them outright, so every entry point still fails
    // closed and nothing outside the worktree becomes reachable through them.
    for (const candidate of ['bad\u0001name.txt', 'wild*card.txt', 'question?.txt', 'angle<bracket>.txt', 'pipe|name.txt', 'quote"name.txt']) {
      await expect(service.readFile(root, candidate)).rejects.toThrow();
      await expect(service.listFiles(root, candidate)).rejects.toThrow();
      await expect(service.prepareEdit(root, candidate, readmeHash, 'replacement\n')).rejects.toThrow();
    }
    expect((await service.listFiles(root)).map(entry => entry.path).sort()).toEqual(['README.md', 'longfilename-for-alias.txt', 'sub']);
  });

  it('refuses secret-named paths and traversal out of the worktree', async () => {
    await refuses('.env', /forbidden|available/i);
    await refuses('.git/config', /forbidden|available/i);
    await refuses('id_rsa', /forbidden/i);
    await refuses('sub/credentials.json', /forbidden/i);
    await expect(service.readFile(root, '../outside/escape.txt')).rejects.toThrow(/forbidden|escapes/i);
    await expect(service.readFile(root, 'sub/../../outside/escape.txt')).rejects.toThrow(/forbidden|escapes/i);
  });

  it('refuses junctions and symlinks that leave the declared worktree root', async () => {
    await expect(service.readFile(root, 'linked/escape.txt')).rejects.toThrow(/symbolic|escapes/i);
    await expect(service.listFiles(root, 'linked')).rejects.toThrow(/symbolic|escapes/i);
    await expect(service.search(root, 'outside', 'linked')).rejects.toThrow(/symbolic|escapes/i);
    await expect(service.prepareEdit(root, 'linked/escape.txt', readmeHash, 'x\n')).rejects.toThrow(/symbolic|escapes/i);
    const listed = await service.listFiles(root);
    expect(listed.map(entry => entry.path)).not.toContain('linked');
    expect(listed.map(entry => entry.path)).toEqual(expect.arrayContaining(['README.md', 'sub']));
    // A whole-tree search must skip the escaping junction instead of following it.
    const found = await service.search(root, 'outside the worktree');
    expect(found.matches).toEqual([]);
  });

  it.runIf(WINDOWS)('canonicalizes 8.3 short-name aliases before screening and containment', async () => {
    const secretAlias = shortBaseName(root, '.env');
    const fileAlias = shortBaseName(root, 'longfilename-for-alias.txt');
    const outsideAlias = shortBaseName(path.dirname(outside), path.basename(outside));

    // An alias for a denied name is denied under the long name it actually resolves to.
    await expect(service.readFile(root, secretAlias)).rejects.toThrow(/forbidden|available/i);
    // An alias for an ordinary file is readable, but only ever reported under its canonical long name.
    await expect(service.readFile(root, fileAlias)).resolves.toMatchObject({ path: 'longfilename-for-alias.txt' });
    // An alias never widens containment: it still resolves outside the root and is refused.
    await expect(service.readFile(root, `../${outsideAlias}/escape.txt`)).rejects.toThrow(/forbidden|escapes/i);
    // Directory listings never surface the alias form.
    expect((await service.listFiles(root)).map(entry => entry.path)).not.toContain(fileAlias);
  });

  it('keeps an approved command working directory inside the worktree', async () => {
    const runner = new CommandRunner();
    const args = { command: 'Write-Output audit', environment: {}, timeoutMs: 1000 };
    await expect(runner.prepare(root, { ...args, cwd: '\\\\?\\C:\\Windows' })).rejects.toThrow(/worktree-relative/i);
    await expect(runner.prepare(root, { ...args, cwd: '//?/C:/Windows' })).rejects.toThrow(/worktree-relative/i);
    await expect(runner.prepare(root, { ...args, cwd: 'C:\\Windows' })).rejects.toThrow(/worktree-relative/i);
    await expect(runner.prepare(root, { ...args, cwd: '../outside' })).rejects.toThrow(/traverse/i);
    await expect(runner.prepare(root, { ...args, cwd: 'sub/../../outside' })).rejects.toThrow(/traverse/i);
    // A junction resolves outside the approved root and is rejected after canonicalization.
    await expect(runner.prepare(root, { ...args, cwd: 'linked' })).rejects.toThrow(/inside the approved root/i);
    // An alternate data stream is not a directory and cannot become one.
    await expect(runner.prepare(root, { ...args, cwd: 'sub:stream' })).rejects.toThrow();
  });
});

// ================================================================ 3. Canary leak matrix

/** Streams scripted text, then optionally fails, so a canary can be injected mid-stream. */
class StreamProvider implements ProviderAdapter {
  constructor(private readonly chunks: string[], private readonly failWith?: string) {}
  async probe(): Promise<never> { throw new Error('probe is not used by this fixture'); }
  async *streamTurn(): AsyncIterable<ProviderEvent> {
    for (const text of this.chunks) yield { type: 'text', text };
    if (this.failWith) throw new Error(this.failWith);
    yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'complete' } } };
  }
}

/** Emits the next scripted batch of tool calls each turn, then finishes with text. */
class ScriptProvider implements ProviderAdapter {
  constructor(private readonly steps: ToolCall[][]) {}
  async probe(): Promise<never> { throw new Error('probe is not used by this fixture'); }
  async *streamTurn(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const calls = this.steps.shift();
    if (calls?.length) {
      for (const call of calls) yield { type: 'tool_call', call };
      yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'script', calls } } };
      return;
    }
    yield { type: 'text', text: 'script complete' };
    yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'complete' } } };
  }
}

/**
 * A minimal stdio MCP server whose only tool returns a canary carried in its own source, so the
 * value can only reach the runtime through the server's stdout — never through stored configuration.
 */
function auditServerSource(secret: string): string {
  return [
    `const secret = ${JSON.stringify(secret)};`,
    `const write = value => process.stdout.write(JSON.stringify(value) + '\\n');`,
    `const listing = { tools: [{ name: 'leak', description: 'Return the audit canary.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };`,
    `const hello = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'audit', version: '1.0.0' } };`,
    `let buffer = '';`,
    `process.stdin.setEncoding('utf8');`,
    `process.stdin.on('data', chunk => {`,
    `  buffer += chunk;`,
    `  for (let index = buffer.indexOf('\\n'); index >= 0; index = buffer.indexOf('\\n')) {`,
    `    const line = buffer.slice(0, index).trim();`,
    `    buffer = buffer.slice(index + 1);`,
    `    if (!line) continue;`,
    `    const message = JSON.parse(line);`,
    `    if (message.id === undefined || message.id === null) continue;`,
    `    const result = message.method === 'initialize' ? hello`,
    `      : message.method === 'tools/list' ? listing`,
    `      : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'value=' + secret }] }`,
    `      : undefined;`,
    `    if (result) write({ jsonrpc: '2.0', id: message.id, result });`,
    `    else write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } });`,
    `  }`,
    `});`
  ].join('\n');
}

describe('credential canary screening and leak matrix', () => {
  // Synthetic canaries. The quoted one is the important case: everything durable in this application is
  // JSON, and a secret carrying a quote, a backslash or a newline does not appear literally in JSON text.
  const PLAIN_CANARY = `CANARY_KEY_${randomUUID().replaceAll('-', '')}`;
  const QUOTED_CANARY = `CANARY_KEY_quote"and\\slash_${randomUUID().replaceAll('-', '')}`;
  const MULTILINE_CANARY = `CANARY_KEY_first\nCANARY_KEY_second_${randomUUID().replaceAll('-', '')}`;
  const PRIVATE_KEY_CANARY = ['-----BEGIN TEST PRIVATE KEY-----', `CANARY_KEY_pem_${randomUUID().replaceAll('-', '')}`, '-----END TEST PRIVATE KEY-----'].join('\n');
  const CANARIES = [PLAIN_CANARY, QUOTED_CANARY, MULTILINE_CANARY, PRIVATE_KEY_CANARY];

  let base: string; let project: string; let databasePath: string;
  let store: Store; let runtime: RuntimeService;
  const events: WorkspaceEvent[] = [];

  const start = (provider?: ProviderAdapter): void => {
    store = new Store(databasePath);
    runtime = new RuntimeService(
      store,
      new RepositoryService(join(base, 'worktrees')),
      event => events.push(event),
      provider ? kind => (kind === 'fake' ? provider : createProvider(kind)) : undefined
    );
  };
  /** Each call replaces the profile's active credential, but every value stays a screened needle. */
  const registerCanaries = (): void => {
    for (const canary of CANARIES) runtime.setCredential(FAKE_PROFILE_ID, canary);
  };
  const createTask = async (mode: 'chat' | 'coding'): Promise<Task> =>
    await runtime.dispatch('task.create', { title: 'Canary audit', projectPath: project, profileId: FAKE_PROFILE_ID, mode, tokenBudget: 500_000 }) as Task;
  const settled = (taskId: string): Promise<void> => waitFor(() => store.task(taskId).status !== 'running', 'the turn to settle');

  /** Every durable and observable surface, read as raw bytes where a file is involved. */
  const surfaces = async (taskId?: string): Promise<Record<string, string>> => {
    const collected: Record<string, string> = {
      events: JSON.stringify(events),
      snapshot: JSON.stringify(await runtime.dispatch('workspace.snapshot', {})),
      mcp: JSON.stringify(await runtime.dispatch('mcp.list', {}))
    };
    for (const suffix of ['', '-wal', '-shm']) {
      collected[`sqlite${suffix || '-main'}`] = await fs.readFile(databasePath + suffix, 'latin1').catch(() => '');
    }
    if (taskId) {
      collected.detail = JSON.stringify(store.detail(taskId));
      collected.providerState = JSON.stringify(store.providerState(taskId) ?? null);
      collected.usage = JSON.stringify(await runtime.dispatch('task.usage', { taskId }));
    }
    const diagnostics = await runtime.dispatch('diagnostics.export', {}) as { path: string };
    collected.diagnostics = await fs.readFile(diagnostics.path, 'utf8');
    return collected;
  };
  const expectNoLeak = async (taskId?: string): Promise<void> => {
    const collected = await surfaces(taskId);
    for (const [surface, content] of Object.entries(collected)) {
      for (const canary of CANARIES) {
        for (const encoding of [canary, JSON.stringify(canary).slice(1, -1)]) {
          if (content.includes(encoding)) throw new Error(`Canary leaked into ${surface}: ${encoding.slice(0, 24)}…`);
        }
      }
    }
  };

  beforeEach(async () => {
    base = await scratch('foundry-canary-audit-');
    project = await gitRepository(join(base, 'source'));
    databasePath = join(base, 'state', 'workspace.db');
    events.length = 0;
  });
  afterEach(async () => { await runtime?.shutdown(); });

  it('screens every JSON encoding level of a registered secret', () => {
    const redactor = new Redactor();
    redactor.add(QUOTED_CANARY);
    redactor.add(MULTILINE_CANARY);
    for (const canary of [QUOTED_CANARY, MULTILINE_CANARY]) {
      const once = JSON.stringify({ value: canary });
      const twice = JSON.stringify({ arguments: once });
      expect(redactor.text(canary)).toBe('[REDACTED]');
      expect(redactor.text(once)).not.toContain('CANARY_KEY_');
      expect(redactor.text(twice)).not.toContain('CANARY_KEY_');
      // The screened text must remain parsable: diagnostics re-parse the scrubbed bundle.
      expect(() => JSON.parse(redactor.text(once)) as unknown).not.toThrow();
    }
    // A short value is not registered as a needle and must not blank unrelated text.
    const narrow = new Redactor();
    narrow.add('ab');
    expect(narrow.text('a stable abacus')).toBe('a stable abacus');
  });

  it('screens private keys and unlabelled tokens that were never registered', () => {
    const redactor = new Redactor();
    expect(redactor.text(`prefix ${PRIVATE_KEY_CANARY} suffix`)).toBe('prefix [REDACTED PRIVATE KEY] suffix');
    expect(redactor.text('Bearer CANARY0123456789abcdefXYZ')).toBe('bearer [REDACTED]');
    expect(redactor.text('authorization: Bearer CANARY0123456789abcdefXYZ')).not.toContain('CANARY');
    // Ordinary prose that merely mentions the scheme keeps its meaning.
    expect(redactor.text('Use a bearer token here.')).toBe('Use a bearer token here.');
  });

  it('never leaks a canary that arrives split across streaming response chunks', async () => {
    start(new StreamProvider(['leading text ', PLAIN_CANARY.slice(0, 11), PLAIN_CANARY.slice(11), ' trailing text']));
    registerCanaries();
    const task = await createTask('chat');
    await runtime.dispatch('task.send', { taskId: task.id, content: 'stream a canary' });
    await settled(task.id);
    const detail = store.detail(task.id) as TaskDetail;
    const assistant = detail.messages.filter(message => message.role === 'assistant').at(-1);
    expect(assistant?.content).toContain('[REDACTED]');
    expect(assistant?.content).toContain('trailing text');
    await expectNoLeak(task.id);
  });

  it('never leaks a canary carried in an exception message', async () => {
    start(new StreamProvider(['partial '], `upstream rejected the request for ${PLAIN_CANARY} and ${QUOTED_CANARY}`));
    registerCanaries();
    const task = await createTask('chat');
    await runtime.dispatch('task.send', { taskId: task.id, content: 'fail with a canary' });
    await settled(task.id);
    const stopped = events.filter(event => event.type === 'task.stopped').at(-1);
    expect(JSON.stringify(stopped?.data)).toContain('[REDACTED]');
    expect(store.task(task.id).status).toBe('failed');
    await expectNoLeak(task.id);
  });

  it('refuses a tool call whose arguments carry a canary, before anything is persisted or executed', async () => {
    const marker = join(base, 'must-not-exist.txt');
    start(new ScriptProvider([[{
      id: 'canary-call-1',
      name: 'run_command',
      // The quoted canary does not appear literally once the call is serialized, which is exactly
      // the encoding every screening guard on this path inspects.
      arguments: { command: `[IO.File]::WriteAllText('${marker.replaceAll('\\', '\\\\')}', '${QUOTED_CANARY}')`, cwd: '', environment: {}, timeoutMs: 1000 }
    }]]));
    registerCanaries();
    const task = await createTask('coding');
    await runtime.dispatch('task.send', { taskId: task.id, content: 'propose a command' });
    await settled(task.id);

    const stopped = events.filter(event => event.type === 'task.stopped').at(-1);
    expect(JSON.stringify(stopped?.data)).toMatch(/secret-like/i);
    // Nothing was proposed to the user and nothing was executed.
    expect(store.approvals(task.id)).toEqual([]);
    await expect(fs.stat(marker)).rejects.toThrow();
    await expectNoLeak(task.id);
  });

  it('refuses a file edit whose content carries a canary and leaves the worktree untouched', async () => {
    start(new ScriptProvider([[{ id: 'canary-edit-1', name: 'read_file', arguments: { path: 'README.md' } }]]));
    registerCanaries();
    const task = await createTask('coding');
    const worktree = store.task(task.id).worktreePath;
    const before = await fs.readFile(join(worktree, 'README.md'), 'utf8');
    const expectedHash = createHash('sha256').update(before, 'utf8').digest('hex');
    await runtime.shutdown();

    start(new ScriptProvider([[{ id: 'canary-edit-2', name: 'write_file', arguments: { path: 'README.md', expectedHash, content: `${before}${QUOTED_CANARY}\n` } }]]));
    registerCanaries();
    await runtime.dispatch('task.send', { taskId: task.id, content: 'propose an edit' });
    await settled(task.id);

    expect(await fs.readFile(join(worktree, 'README.md'), 'utf8')).toBe(before);
    expect(store.approvals(task.id).some(approval => approval.state === 'complete')).toBe(false);
    await expectNoLeak(task.id);
  });

  it.runIf(WINDOWS)('never leaks a canary returned by an MCP tool or written to MCP stderr', async () => {
    // Both servers carry the canary inside their own source, so nothing secret-like is ever stored as
    // configuration: what reaches SQLite can only have come through the server's stdout or stderr.
    const serving = join(base, 'audit-mcp-server.mjs');
    await fs.writeFile(serving, auditServerSource(PLAIN_CANARY));
    const failing = join(base, 'audit-mcp-failure.mjs');
    await fs.writeFile(failing, `process.stderr.write(${JSON.stringify(`startup failed: ${QUOTED_CANARY}`)}); process.exit(1);`);

    start(new ScriptProvider([[{ id: 'mcp-canary-1', name: 'mcp__audit__leak', arguments: {} }]]));
    registerCanaries();
    const saved = await runtime.dispatch('mcp.save', {
      id: randomUUID(), key: 'audit', name: 'Audit server', command: process.execPath, arguments: [serving],
      cwd: '', environment: {}, enabled: true, readOnlyTools: ['leak'], callTimeoutMs: 10_000
    }) as McpServerStatus;
    expect(saved.running).toBe(true);
    expect(saved.tools.map(tool => tool.name)).toEqual(['leak']);

    const direct = await runtime.mcp.call(saved, 'leak', {}, new AbortController().signal);
    expect(direct.content).toBe('value=[REDACTED]');

    // An allowlisted read-only MCP result is persisted into provider state without a further decision,
    // so screening it is the only thing between the server's stdout and the database.
    const task = await createTask('coding');
    await runtime.dispatch('task.send', { taskId: task.id, content: 'call the external tool' });
    await settled(task.id);
    expect(events.some(event => event.type === 'task.tool-result')).toBe(true);
    const persisted = [databasePath, `${databasePath}-wal`].map(file => fs.readFile(file, 'latin1').catch(() => ''));
    expect((await Promise.all(persisted)).join('')).toContain('value=[REDACTED]');

    // A server that fails on launch while printing a canary to stderr must not persist it either.
    const failed = await runtime.dispatch('mcp.save', {
      id: randomUUID(), key: 'noisy', name: 'Noisy server', command: process.execPath, arguments: [failing],
      cwd: '', environment: {}, enabled: true, readOnlyTools: [], callTimeoutMs: 10_000
    }) as McpServerStatus;
    expect(failed.running).toBe(false);
    expect(failed.lastError).toMatch(/failed to start/i);

    await expectNoLeak(task.id);
  }, 90_000);

  it.runIf(WINDOWS)('refuses to connect an MCP server configured with secret-like values', async () => {
    start();
    registerCanaries();
    const serving = join(base, 'audit-mcp-server.mjs');
    await fs.writeFile(serving, auditServerSource('not-a-canary'));
    const leaky = await runtime.dispatch('mcp.save', {
      id: randomUUID(), key: 'leaky', name: 'Leaky config', command: process.execPath, arguments: [serving],
      cwd: '', environment: { AUDIT_LABEL: PLAIN_CANARY }, enabled: true, readOnlyTools: [], callTimeoutMs: 10_000
    }) as McpServerStatus;
    // The server is never launched and none of its tools are ever advertised to a model.
    expect(leaky.running).toBe(false);
    expect(leaky.tools).toEqual([]);
    expect(leaky.lastError).toMatch(/secret-like/i);
    expect(runtime.mcp.toolDefinitions()).toEqual([]);
    // Open finding, reported separately: `RuntimeService.dispatch`'s `mcp.save` catch branch stores the
    // rejected configuration verbatim (packages/runtime/src/service.ts), so the refused environment
    // value still reaches `mcp_servers.data` and is read back by `mcp.list`. The fix belongs in
    // service.ts, which Workstream A must not edit, so this suite does not yet assert its absence.
  }, 60_000);
});

// ================================================================ 4. Job Object reclamation

describe.runIf(WINDOWS)('Job Object process tree reclamation', () => {
  const POWERSHELL = '"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';
  const quote = (value: string): string => value.replaceAll("'", "''");
  /** A command that records its own pid, starts a detached grandchild that records its pid, then lingers. */
  const treeCommand = (root: string, lingerSeconds: number): string => {
    const grandchild = `[IO.File]::WriteAllText('${quote(join(root, 'child.pid'))}', $PID); Start-Sleep -Seconds 120`;
    return `[IO.File]::WriteAllText('${quote(join(root, 'root.pid'))}', $PID); Start-Process -WindowStyle Hidden -FilePath ${POWERSHELL} -ArgumentList '-NoProfile','-NonInteractive','-Command','${quote(grandchild)}'; Start-Sleep -Seconds ${lingerSeconds}`;
  };
  const treePids = async (root: string): Promise<number[]> => {
    await waitFor(async () => {
      const found = await Promise.all(['root.pid', 'child.pid'].map(name => fs.readFile(join(root, name), 'utf8').then(value => value.trim().length > 0, () => false)));
      return found.every(Boolean);
    }, 'the command process tree to report its pids');
    return Promise.all(['root.pid', 'child.pid'].map(async name => Number((await fs.readFile(join(root, name), 'utf8')).trim())));
  };

  it('terminates every command descendant when the root command times out', async () => {
    const root = await gitRepository(join(await scratch('foundry-job-timeout-'), 'worktree'));
    const runner = new CommandRunner();
    const prepared = await runner.prepare(root, { command: treeCommand(root, 120), cwd: '', environment: {}, timeoutMs: 8_000 });
    const executing = runner.execute(prepared, new AbortController().signal);
    const pids = await treePids(root);
    expect(pids.every(alive)).toBe(true);

    const result = await executing;
    expect(result).toMatchObject({ timedOut: true, cancelled: false, exitCode: null, cleanupVerified: true });
    await waitFor(() => pids.every(pid => !alive(pid)), 'every command descendant to be reclaimed');
  }, 60_000);

  it('terminates a background descendant that outlives a command exiting normally', async () => {
    const root = await gitRepository(join(await scratch('foundry-job-exit-'), 'worktree'));
    const runner = new CommandRunner();
    // The root exits on its own well before its timeout; only the Job Object can still reach the
    // detached grandchild, which holds the inherited output handles open behind it.
    const prepared = await runner.prepare(root, { command: treeCommand(root, 3), cwd: '', environment: {}, timeoutMs: 30_000 });
    const executing = runner.execute(prepared, new AbortController().signal);
    const pids = await treePids(root);

    const result = await executing;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, cleanupVerified: true });
    expect(result.stderr).toContain('[background job descendants terminated]');
    await waitFor(() => pids.every(pid => !alive(pid)), 'every command descendant to be reclaimed');
  }, 60_000);

  it('terminates every command descendant when the user cancels', async () => {
    const root = await gitRepository(join(await scratch('foundry-job-cancel-'), 'worktree'));
    const runner = new CommandRunner();
    const controller = new AbortController();
    const prepared = await runner.prepare(root, { command: treeCommand(root, 120), cwd: '', environment: {}, timeoutMs: 120_000 });
    const executing = runner.execute(prepared, controller.signal);
    try {
      const pids = await treePids(root);
      controller.abort();
      const result = await executing;
      expect(result).toMatchObject({ cancelled: true, timedOut: false, exitCode: null, cleanupVerified: true });
      await waitFor(() => pids.every(pid => !alive(pid)), 'every command descendant to be reclaimed');
    } finally {
      controller.abort();
      await executing.catch(() => undefined);
    }
  }, 60_000);

  it('terminates MCP server descendants when the hosted session is stopped', async () => {
    const base = await scratch('foundry-job-mcp-');
    const store = new Store(join(base, 'state', 'workspace.db'));
    const runtime = new RuntimeService(store, new RepositoryService(join(base, 'worktrees')), () => undefined);
    try {
      const saved = await runtime.dispatch('mcp.save', {
        id: randomUUID(), key: 'fixture', name: 'Job fixture', command: process.execPath, arguments: [FIXTURE_SERVER],
        cwd: '', environment: { MCP_FIXTURE_NOTES: join(base, 'notes.txt') }, enabled: true, readOnlyTools: ['spawn_child'], callTimeoutMs: 5000
      }) as McpServerStatus;
      const spawned = await runtime.mcp.call(saved, 'spawn_child', {}, new AbortController().signal);
      const pid = (JSON.parse(spawned.content) as { pid: number }).pid;
      expect(alive(pid)).toBe(true);

      await runtime.mcp.stopServer(saved.id);
      // The kill-on-close Job Object owns the whole tree, not just the server process it launched.
      await waitFor(() => !alive(pid), 'the MCP server descendant to be reclaimed');
      expect(runtime.mcp.statusOf(saved.id).running).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  }, 60_000);
});
