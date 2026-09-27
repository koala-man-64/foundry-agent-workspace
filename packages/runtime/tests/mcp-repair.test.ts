import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/store';
import { Redactor } from '../src/redaction';
import { repairMcpConfigurations } from '../src/mcp-repair';

describe('historical MCP configuration repair', () => {
  let directory: string; let store: Store; let id: string;
  const canary = 'ordinary-value-known-only-to-vault';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foundry-mcp-repair-'));
    store = new Store(join(directory, 'workspace.db'));
    id = randomUUID();
    store.saveMcpServer({ id, key: 'prior', name: 'Prior config', command: process.execPath, arguments: [], cwd: directory, environment: { LABEL: canary }, enabled: true, readOnlyTools: [], callTimeoutMs: 10_000 }, { tools: [], toolsListedAt: null, serverInfo: null, lastError: null });
  });
  afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = (): string => (store.db.prepare('SELECT data FROM mcp_servers WHERE id=?').get(id) as { data: string }).data;

  it('makes a verified WAL-aware backup, then quarantines a newly recognized plain value', async () => {
    const redactor = new Redactor(); redactor.add(canary);
    const result = await repairMcpConfigurations(store, redactor);
    expect(result.repairedIds).toEqual([id]); expect(result.backupPath).toBeTruthy();
    expect(raw()).not.toContain(canary);
    expect(store.mcpServer(id)).toMatchObject({ enabled: false, environment: {}, arguments: [], tools: [] });
    const backup = new Database(result.backupPath!, { readonly: true, fileMustExist: true });
    try { expect(backup.pragma('integrity_check', { simple: true })).toBe('ok'); expect((backup.prepare('SELECT data FROM mcp_servers WHERE id=?').get(id) as { data: string }).data).toContain(canary); }
    finally { backup.close(); }
    const protectedDirectory = dirname(result.backupPath!);
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const acl = execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:FOUNDRY_TEST_BACKUP_DIRECTORY).Sddl'], { encoding: 'utf8', env: { SystemRoot: systemRoot, WINDIR: systemRoot, FOUNDRY_TEST_BACKUP_DIRECTORY: protectedDirectory } });
      expect(acl).toMatch(/D:P/); expect(acl).toContain(';;;SY)'); expect(acl).toContain(';;;BA)');
    } else expect((await stat(protectedDirectory)).mode & 0o777).toBe(0o700);
    expect((await repairMcpConfigurations(store, redactor)).repairedIds).toEqual([]);
  });

  it('does not rewrite a live row when backup creation fails', async () => {
    const redactor = new Redactor(); redactor.add(canary);
    await expect(repairMcpConfigurations(store, redactor, { backup: async () => { throw new Error('backup unavailable'); } })).rejects.toThrow('backup unavailable');
    expect(raw()).toContain(canary);
    expect(store.mcpServer(id)?.enabled).toBe(true);
  });

  it('refuses repair when backup protection fails before copying', async () => {
    const redactor = new Redactor(); redactor.add(canary);
    let copied = false;
    await expect(repairMcpConfigurations(store, redactor, {
      protect: async () => { throw new Error('ACL unavailable'); },
      backup: async () => { copied = true; },
    })).rejects.toThrow('ACL unavailable');
    expect(copied).toBe(false);
    expect(raw()).toContain(canary);
    expect(store.mcpServer(id)?.enabled).toBe(true);
  });

  it('does not create a backup when nothing is newly recognized as sensitive', async () => {
    const result = await repairMcpConfigurations(store, new Redactor());
    expect(result).toEqual({ repairedIds: [] });
    expect(raw()).toContain(canary);
  });
});
