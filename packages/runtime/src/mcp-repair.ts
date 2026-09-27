import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Store } from './store';
import type { Redactor } from './redaction';
import { sanitizeStoredMcp, type StoredMcpServer } from './mcp-config';
import { protectedBackupPath } from './backup-protection';

interface McpRow { id: string; data: string; tools: string; server_info: string | null; last_error: string | null; }
export interface McpRepairResult { repairedIds: string[]; backupPath?: string; }
export interface McpRepairOptions { backup?: (path: string) => Promise<unknown>; protect?: (directory: string, filename: string) => Promise<string>; }

/**
 * Repair newly recognized vault values in historical MCP configs. The verified backup is retained;
 * SQLite WAL/free pages and OS backups can still hold previous bytes and are not claimed erased.
 */
export async function repairMcpConfigurations(store: Store, redactor: Redactor, options: McpRepairOptions = {}): Promise<McpRepairResult> {
  const rows = mcpRows(store.db);
  const dirty = rows.flatMap(row => {
    const original = store.mcpServer(row.id);
    if (!original) throw new Error('MCP configuration disappeared during repair preflight.');
    const safe = sanitizeStoredMcp(original, redactor);
    return safe === original ? [] : [{ row, safe }];
  });
  if (!dirty.length) return { repairedIds: [] };

  const directory = join(dirname(store.path), 'backups');
  const backupPath = await (options.protect ?? protectedBackupPath)(directory, `mcp-repair-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.db`);
  let verified = false;
  try {
    await (options.backup ?? (path => store.db.backup(path)))(backupPath);
    const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('MCP repair backup failed integrity verification.');
      if (Number(copy.pragma('user_version', { simple: true })) !== store.schemaVersion) throw new Error('MCP repair backup schema changed.');
      if (JSON.stringify(mcpRows(copy)) !== JSON.stringify(rows)) throw new Error('MCP repair backup does not match the source configurations.');
    } finally { copy.close(); }
    verified = true;
  } catch (error) {
    if (!verified) await rm(backupPath, { force: true }).catch(() => undefined);
    throw error;
  }

  store.transaction(() => {
    const update = store.db.prepare('UPDATE mcp_servers SET data=?,tools=?,server_info=?,last_error=?,updated_at=? WHERE id=? AND data=? AND tools=? AND server_info IS ? AND last_error IS ?');
    for (const { row, safe } of dirty) {
      const config = safeConfig(safe);
      const outcome = update.run(JSON.stringify(config), JSON.stringify(safe.tools), safe.serverInfo ? JSON.stringify(safe.serverInfo) : null, safe.lastError, new Date().toISOString(), row.id, row.data, row.tools, row.server_info, row.last_error);
      if (outcome.changes !== 1) throw new Error('MCP configuration changed after backup; repair was rolled back.');
    }
  });
  return { repairedIds: dirty.map(item => item.row.id), backupPath };
}

function safeConfig(server: StoredMcpServer): object {
  return { id: server.id, key: server.key, name: server.name, command: server.command, arguments: server.arguments,
    cwd: server.cwd, environment: server.environment, enabled: server.enabled, readOnlyTools: server.readOnlyTools, callTimeoutMs: server.callTimeoutMs };
}
function mcpRows(db: Database.Database): McpRow[] {
  return db.prepare('SELECT id,data,tools,server_info,last_error FROM mcp_servers ORDER BY id').all() as McpRow[];
}
