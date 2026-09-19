import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PHASE4_SCHEMA, V1_SCHEMA, V2_MIGRATION } from './schema';
import type { Approval, CompactionRecord, McpServerConfig, McpServerStatus, McpTool, Message, ModelProfile, ProviderContinuation, ProviderToolResult, Snapshot, Task, TaskDetail, ToolCall, UsageRecord, WorkspaceEvent } from '../../protocol/src/index';

export interface ProviderState { fingerprint: string; continuation: ProviderContinuation; pending: ToolCall[]; results: ProviderToolResult[]; seenToolCallIds?: string[]; }

interface CompactionRow { id: string; task_id: string; from_ordinal: number; to_ordinal: number; message_ids: string; summary: string; estimated_before: number; estimated_after: number; created_at: string }
interface UsageRow { id: string; task_id: string; request_id: string; reserved: number; prompt_tokens: number | null; completion_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null; usage_known: number; reason: string | null; created_at: string }
interface McpRow { id: string; key: string; data: string; tools: string; tools_listed_at: string | null; server_info: string | null; last_error: string | null; updated_at: string }

export const FAKE_PROFILE_ID = '00000000-0000-4000-8000-000000000001';
export const CURRENT_SCHEMA_VERSION = 2;
/** Test-only fault injection for migration and backup failure paths. */
export interface StoreOptions { migrationFault?: 'after-ddl'; backupFault?: 'copy' | 'verify' }
export class Store {
  readonly db: Database.Database;
  private schema: number;
  constructor(readonly path: string, private readonly options: StoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > CURRENT_SCHEMA_VERSION) { this.db.close(); throw new Error('This database requires a newer application.'); }
    const fresh = version === 0 && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
    this.db.transaction(() => {
      this.db.exec(V1_SCHEMA);
      // Only a brand-new database is created at v2. An existing v1 database keeps its
      // schema until the user confirms a verified, backed-up upgrade.
      if (fresh) { this.db.exec(V2_MIGRATION); this.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`); }
      else if (version === 0) this.db.pragma('user_version = 1');
      this.db.exec(PHASE4_SCHEMA);
      if (!this.profile(FAKE_PROFILE_ID)) this.saveProfile({ id: FAKE_PROFILE_ID, name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'deterministic-fixture', contextLimit: 32000, outputLimit: 2048 });
    })();
    this.schema = Number(this.db.pragma('user_version', { simple: true }));
    this.recover();
  }
  get schemaVersion(): number { return this.schema; }
  get orchestrationAvailable(): boolean { return this.schema >= 2; }
  close(): void { this.db.close(); }
  /**
   * v1 -> v2. The caller must already have stopped admission and active work. Uses SQLite's
   * online backup (WAL-aware), verifies the copy opens read-only with integrity `ok` and the
   * same v1 rows, then applies the additive migration in one transaction. The backup is kept.
   */
  async upgradeToV2(backupDirectory = join(dirname(this.path), 'backups')): Promise<{ version: number; backupPath: string }> {
    if (this.schema !== 1) throw new Error(this.schema === CURRENT_SCHEMA_VERSION ? 'The database is already current.' : 'Unsupported database version for upgrade.');
    mkdirSync(backupDirectory, { recursive: true });
    const backupPath = join(backupDirectory, `workspace-v1-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.db`);
    if (this.options.backupFault === 'copy') throw new Error('Backup failed before the upgrade; the database was not changed.');
    await this.db.backup(backupPath);
    const expected = this.rowCounts(this.db);
    const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = copy.pragma('integrity_check', { simple: true });
      const copyVersion = Number(copy.pragma('user_version', { simple: true }));
      if (this.options.backupFault === 'verify' || integrity !== 'ok' || copyVersion !== 1 || JSON.stringify(this.rowCounts(copy)) !== JSON.stringify(expected)) throw new Error('Backup verification failed; the database was not changed.');
    } finally { copy.close(); }
    this.db.transaction(() => {
      this.db.exec(V2_MIGRATION);
      if (this.options.migrationFault === 'after-ddl') throw new Error('Injected migration failure.');
      this.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    })();
    this.schema = Number(this.db.pragma('user_version', { simple: true }));
    const check = this.db.pragma('foreign_key_check') as unknown[];
    if (check.length) throw new Error('Foreign key verification failed after upgrade; retain the verified backup.');
    return { version: this.schema, backupPath };
  }
  private rowCounts(db: Database.Database): Record<string, number> {
    return Object.fromEntries(['tasks', 'messages', 'profiles', 'events', 'intents'].map(table => [table, (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
  }
  requireOrchestration(): void { if (!this.orchestrationAvailable) throw new Error('Coordinated tasks require the backed-up database upgrade. Upgrade from the workspace banner first.'); }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  private parse<T>(row: unknown): T | undefined { return row ? JSON.parse((row as { data: string }).data) as T : undefined; }
  profile(id: string): ModelProfile | undefined { return this.parse<ModelProfile>(this.db.prepare('SELECT data FROM profiles WHERE id = ?').get(id)); }
  saveProfile(profile: ModelProfile): ModelProfile { this.db.prepare('INSERT OR REPLACE INTO profiles(id, data) VALUES (?, ?)').run(profile.id, JSON.stringify(profile)); return profile; }
  task(id: string): Task {
    const task = this.parse<Task>(this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id));
    if (!task) throw new Error('Task not found.');
    return task;
  }
  saveTask(task: Task): Task { this.db.prepare('INSERT OR REPLACE INTO tasks(id, data) VALUES (?, ?)').run(task.id, JSON.stringify(task)); return task; }
  saveMessage(message: Message): void {
    const existing = this.db.prepare('SELECT id FROM messages WHERE id = ?').get(message.id);
    if (existing) this.db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify(message), message.id);
    else this.db.prepare('INSERT INTO messages(id, task_id, data, ordinal) VALUES (?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM messages))').run(message.id, message.taskId, JSON.stringify(message));
  }
  detail(id: string): TaskDetail {
    const approvals = this.approvals(id).slice(-30); let evidenceBytes = 0;
    // Keep recent full evidence within the RPC frame limit; older records retain
    // their hashes and summary. The durable database retains every proposal.
    for (let i = approvals.length - 1; i >= 0; i--) {
      const approval = approvals[i]!;
      evidenceBytes += Buffer.byteLength(JSON.stringify(approval), 'utf8');
      if (evidenceBytes > 384 * 1024 && approval.state !== 'awaiting-approval' && approval.state !== 'unknown') { delete approval.before; delete approval.after; if (approval.result) approval.result.content = approval.result.content.slice(0, 1000); }
    }
    const compactions = this.compactions(id);
    const hasUnknownPublication = this.unknownPublicationIntents(id).length > 0;
    return { task: this.task(id), messages: this.db.prepare('SELECT data FROM messages WHERE task_id = ? ORDER BY ordinal').all(id).map(row => this.parse<Message>(row)!), approvals, ...(compactions.length ? { compactions } : {}), ...(hasUnknownPublication ? { hasUnknownPublication: true } : {}) };
  }
  /** Messages with their durable ordinals; compaction ranges are expressed in ordinals. */
  messagesWithOrdinals(taskId: string): (Message & { ordinal: number })[] {
    return (this.db.prepare('SELECT data, ordinal FROM messages WHERE task_id = ? ORDER BY ordinal').all(taskId) as { data: string; ordinal: number }[]).map(row => ({ ...JSON.parse(row.data) as Message, ordinal: row.ordinal }));
  }
  compactions(taskId: string): CompactionRecord[] {
    return (this.db.prepare('SELECT * FROM compactions WHERE task_id = ? ORDER BY from_ordinal').all(taskId) as CompactionRow[]).map(row => ({ id: row.id, taskId: row.task_id, fromOrdinal: row.from_ordinal, toOrdinal: row.to_ordinal, messageIds: JSON.parse(row.message_ids) as string[], summary: row.summary, estimatedTokensBefore: row.estimated_before, estimatedTokensAfter: row.estimated_after, createdAt: row.created_at }));
  }
  saveCompaction(record: CompactionRecord, providerStateBefore: ProviderState | undefined, providerStateAfter: ProviderState | undefined): void {
    this.db.prepare('INSERT INTO compactions(id, task_id, from_ordinal, to_ordinal, message_ids, summary, estimated_before, estimated_after, provider_state_before, provider_state_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.taskId, record.fromOrdinal, record.toOrdinal, JSON.stringify(record.messageIds), record.summary, record.estimatedTokensBefore, record.estimatedTokensAfter, providerStateBefore ? JSON.stringify(providerStateBefore) : null, providerStateAfter ? JSON.stringify(providerStateAfter) : null, record.createdAt);
  }
  saveUsageRecord(record: UsageRecord): void {
    this.db.prepare('INSERT INTO usage_records(id, task_id, request_id, reserved, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens, usage_known, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.taskId, record.requestId, record.reservedTokens, record.promptTokens, record.completionTokens, record.cacheReadTokens, record.cacheCreationTokens, record.usageKnown ? 1 : 0, record.reason, record.createdAt);
  }
  usageRecords(taskId: string, limit = 100): { records: UsageRecord[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM usage_records WHERE task_id = ?').get(taskId) as { count: number }).count;
    const rows = this.db.prepare('SELECT * FROM usage_records WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(taskId, limit) as UsageRow[];
    return { total, records: rows.reverse().map(row => ({ id: row.id, taskId: row.task_id, requestId: row.request_id, reservedTokens: row.reserved, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens, usageKnown: row.usage_known === 1, reason: row.reason, createdAt: row.created_at })) };
  }
  usageTotals(taskId: string): { requests: number; knownRequests: number; unknownRequests: number; prompt: number; completion: number; cacheRead: number; cacheCreation: number; reservedUnknown: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(usage_known), 0) AS known, COALESCE(SUM(CASE WHEN usage_known = 1 THEN prompt_tokens ELSE 0 END), 0) AS prompt,
      COALESCE(SUM(CASE WHEN usage_known = 1 THEN completion_tokens ELSE 0 END), 0) AS completion, COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read,
      COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cache_creation, COALESCE(SUM(CASE WHEN usage_known = 0 THEN reserved ELSE 0 END), 0) AS reserved_unknown FROM usage_records WHERE task_id = ?`).get(taskId) as { requests: number; known: number; prompt: number; completion: number; cache_read: number; cache_creation: number; reserved_unknown: number };
    return { requests: row.requests, knownRequests: row.known, unknownRequests: row.requests - row.known, prompt: row.prompt, completion: row.completion, cacheRead: row.cache_read, cacheCreation: row.cache_creation, reservedUnknown: row.reserved_unknown };
  }
  mcpServers(): McpServerStatus[] { return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY key').all() as McpRow[]).map(row => this.mcpStatus(row)); }
  mcpServer(id: string): McpServerStatus | undefined { const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpRow | undefined; return row ? this.mcpStatus(row) : undefined; }
  saveMcpServer(config: McpServerConfig, listing: { tools: McpTool[]; toolsListedAt: string | null; serverInfo: { name: string; version: string } | null; lastError: string | null }): McpServerStatus {
    this.db.prepare('INSERT INTO mcp_servers(id, key, data, tools, tools_listed_at, server_info, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET key = excluded.key, data = excluded.data, tools = excluded.tools, tools_listed_at = excluded.tools_listed_at, server_info = excluded.server_info, last_error = excluded.last_error, updated_at = excluded.updated_at')
      .run(config.id, config.key, JSON.stringify(config), JSON.stringify(listing.tools), listing.toolsListedAt, listing.serverInfo ? JSON.stringify(listing.serverInfo) : null, listing.lastError, new Date().toISOString());
    return this.mcpServer(config.id)!;
  }
  removeMcpServer(id: string): boolean { return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0; }
  private mcpStatus(row: McpRow): McpServerStatus {
    return { ...JSON.parse(row.data) as McpServerConfig, tools: JSON.parse(row.tools) as McpTool[], toolsListedAt: row.tools_listed_at, serverInfo: row.server_info ? JSON.parse(row.server_info) as { name: string; version: string } : null, lastError: row.last_error, running: false };
  }
  providerState(taskId: string): ProviderState | undefined { return this.parse<ProviderState>(this.db.prepare("SELECT data FROM intents WHERE id = ? AND kind = 'provider.context'").get(taskId)); }
  saveProviderState(taskId: string, state: ProviderState): void { this.db.prepare("INSERT OR REPLACE INTO intents VALUES (?, 'provider.context', ?, 'complete')").run(taskId, JSON.stringify(state)); }
  approvals(taskId: string): Approval[] { return this.db.prepare("SELECT data, state FROM intents WHERE kind = 'tool.approval' ORDER BY rowid").all().map(row => ({ ...this.parse<Approval>(row)!, state: (row as { state: Approval['state'] }).state })).filter(item => item.taskId === taskId); }
  approval(id: string): Approval {
    const row = this.db.prepare("SELECT data, state FROM intents WHERE id = ? AND kind = 'tool.approval'").get(id) as { data: string; state: Approval['state'] } | undefined;
    if (!row) throw new Error('Approval not found.');
    return { ...JSON.parse(row.data) as Approval, state: row.state };
  }
  saveApproval(approval: Approval): void { this.db.prepare("INSERT INTO intents VALUES (?, 'tool.approval', ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, state = excluded.state").run(approval.id, JSON.stringify(approval), approval.state); }
  allTasks(): Task[] { return this.db.prepare('SELECT data FROM tasks').all().map(row => this.parse<Task>(row)!); }
  snapshot(): Snapshot {
    return {
      // Child agents appear under their coordinator, never as unrelated top-level tasks.
      tasks: this.allTasks().filter(task => !task.parentTaskId).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)),
      profiles: this.db.prepare('SELECT data FROM profiles ORDER BY id').all().map(row => this.parse<ModelProfile>(row)!),
      lastSequence: (this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events').get() as { value: number }).value,
      runtime: 'ready'
    };
  }
  event(type: string, data: unknown, taskId?: string): WorkspaceEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(type, task_id, data, created_at) VALUES (?, ?, ?, ?)').run(type, taskId ?? null, JSON.stringify(data), createdAt);
    return { sequence: Number(result.lastInsertRowid), type, taskId, data, createdAt };
  }
  recentEvents(limit: number): WorkspaceEvent[] {
    return (this.db.prepare('SELECT sequence, type, task_id, data, created_at FROM events ORDER BY sequence DESC LIMIT ?').all(limit) as { sequence: number; type: string; task_id: string | null; data: string; created_at: string }[])
      .reverse().map(row => ({ sequence: row.sequence, type: row.type, taskId: row.task_id ?? undefined, data: JSON.parse(row.data) as unknown, createdAt: row.created_at }));
  }
  intent(kind: string, data: unknown): string {
    const id = randomUUID(); this.db.prepare('INSERT INTO intents VALUES (?, ?, ?, ?)').run(id, kind, JSON.stringify(data), 'pending'); return id;
  }
  finishIntent(id: string, state: 'complete' | 'unknown'): void { this.db.prepare('UPDATE intents SET state = ? WHERE id = ?').run(state, id); }
  unknownIntents(): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM intents WHERE kind = 'worktree.create' AND state = 'unknown'").get() as { count: number }).count; }
  unknownPublicationIntents(taskId: string): Array<{ id: string; kind: string; data: unknown }> {
    const rows = this.db.prepare("SELECT id, kind, data FROM intents WHERE kind IN ('git.push', 'git.commit') AND state = 'unknown'").all() as { id: string; kind: string; data: string }[];
    return rows.filter(row => {
      try { return (JSON.parse(row.data) as { taskId?: string }).taskId === taskId; } catch { return false; }
    }).map(row => ({ id: row.id, kind: row.kind, data: JSON.parse(row.data) as unknown }));
  }
  clearPublicationIntent(intentId: string, state: 'complete' | 'failed' = 'failed'): void {
    this.db.prepare("UPDATE intents SET state = ? WHERE id = ? AND kind IN ('git.push', 'git.commit')").run(state, intentId);
  }
  unknownRetireIntents(taskId: string): Array<{ id: string; data: unknown }> {
    const rows = this.db.prepare("SELECT id, data FROM intents WHERE kind = 'worktree.retire' AND state = 'unknown'").all() as { id: string; data: string }[];
    return rows.filter(row => {
      try { return (JSON.parse(row.data) as { taskId?: string }).taskId === taskId; } catch { return false; }
    }).map(row => ({ id: row.id, data: JSON.parse(row.data) as unknown }));
  }
  clearRetireIntent(intentId: string, state: 'complete' | 'failed' = 'failed'): void {
    this.db.prepare("UPDATE intents SET state = ? WHERE id = ? AND kind = 'worktree.retire'").run(state, intentId);
  }
  private recoverOrchestration(): void {
    const now = new Date().toISOString();
    // Interrupted requests keep their full conservative reservation; nothing is refunded.
    const interrupted = this.db.prepare("SELECT request_id, run_task_id, amount FROM budget_reservations WHERE state = 'reserved'").all() as { request_id: string; run_task_id: string; amount: number }[];
    for (const row of interrupted) {
      const exists = this.db.prepare("SELECT 1 FROM usage_records WHERE request_id = ?").get(row.request_id);
      if (!exists) {
        this.saveUsageRecord({
          id: randomUUID(),
          taskId: row.run_task_id,
          requestId: row.request_id,
          reservedTokens: row.amount,
          promptTokens: null,
          completionTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          usageKnown: false,
          reason: 'Runtime restarted before usage was recorded.',
          createdAt: now
        });
      }
    }
    this.db.prepare("UPDATE budget_reservations SET state = 'retained', charged = amount, reason = 'Runtime restarted before usage was recorded.', settled_at = ? WHERE state = 'reserved'").run(now);
    this.db.prepare("UPDATE handoff_operations SET state = 'revoked', updated_at = ? WHERE state = 'awaiting-approval'").run(now);
    this.db.prepare("UPDATE handoff_operations SET state = 'unknown', detail = 'Runtime restarted during the commit operation.', updated_at = ? WHERE state IN ('executing', 'staged', 'committed')").run(now);
    this.db.prepare("UPDATE integration_operations SET state = 'revoked', updated_at = ? WHERE state = 'awaiting-approval'").run(now);
    this.db.prepare("UPDATE integration_operations SET state = 'unknown', observed = json_object('detail', 'Runtime restarted during integration.'), updated_at = ? WHERE state = 'executing'").run(now);
    // Restart never resumes paid inference or mutations silently.
    this.db.prepare("UPDATE agent_runs SET lifecycle = 'waiting', wait_reason = CASE WHEN lifecycle = 'preparing' THEN 'reconciliation' ELSE 'user-continuation' END, updated_at = ? WHERE lifecycle IN ('queued', 'preparing', 'running')").run(now);
  }
  private recover(): void {
    this.transaction(() => {
      this.db.prepare("UPDATE intents SET state = 'unknown' WHERE state = 'pending'").run();
      this.db.prepare("UPDATE intents SET state = 'revoked' WHERE kind = 'tool.approval' AND state IN ('awaiting-approval', 'approved')").run();
      this.db.prepare("UPDATE intents SET state = 'unknown' WHERE kind = 'tool.approval' AND state = 'executing'").run();
      if (this.schema >= 2) this.recoverOrchestration();
      for (const task of this.allTasks()) {
        if (task.status === 'running') {
          task.status = 'interrupted'; task.updatedAt = new Date().toISOString(); this.saveTask(task);
          for (const message of this.detail(task.id).messages) {
            if (message.status === 'streaming') this.saveMessage({ ...message, status: 'interrupted' });
          }
          const totals = this.usageTotals(task.id);
          const recorded = totals.prompt + totals.completion + totals.reservedUnknown;
          const unrecorded = task.usedTokens - recorded;
          if (unrecorded > 0) {
            this.saveUsageRecord({
              id: randomUUID(),
              taskId: task.id,
              requestId: randomUUID(),
              reservedTokens: unrecorded,
              promptTokens: null,
              completionTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              usageKnown: false,
              reason: 'Runtime restarted before usage was recorded.',
              createdAt: new Date().toISOString()
            });
          }
          this.event('task.interrupted', { reason: 'Runtime restarted; partial response retained. Reserved usage retained conservatively.' }, task.id);
        } else if (task.status !== 'retired' && this.messagesWithOrdinals(task.id).length === 0 && task.usedTokens > 0) {
          // A task that crashed after reservation but before messages were saved was safely unstarted; reset unrecorded hold.
          task.usedTokens = 0;
          task.updatedAt = new Date().toISOString();
          this.saveTask(task);
        }
      }
    });
  }
}
