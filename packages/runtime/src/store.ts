import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PHASE4_SCHEMA, V1_SCHEMA, V2_MIGRATION, V3_MIGRATION, V4_MIGRATION } from './schema';
import { UsageLedger } from './usage-ledger';
import { isGitTask, type Approval, type CompactionRecord, type GitTask, type McpServerConfig, type McpServerStatus, type McpTool, type Message, type ModelProfile, type Project, type ProviderContinuation, type ProviderToolResult, type Snapshot, type Task, type TaskDetail, type ToolCall, type UsageRecord, type UsageFilters, type UsageGroup, type WorkspaceEvent, type WorkspacePreferences } from '../../protocol/src/index';

export interface ProviderState { fingerprint: string; continuation: ProviderContinuation; pending: ToolCall[]; results: ProviderToolResult[]; seenToolCallIds?: string[]; }

interface CompactionRow { id: string; task_id: string; from_ordinal: number; to_ordinal: number; message_ids: string; summary: string; estimated_before: number; estimated_after: number; created_at: string }
interface UsageRow { id: string; task_id: string; request_id: string; reserved: number; prompt_tokens: number | null; completion_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null; usage_known: number; reason: string | null; created_at: string }
interface McpRow { id: string; key: string; data: string; tools: string; tools_listed_at: string | null; server_info: string | null; last_error: string | null; updated_at: string }

export const FAKE_PROFILE_ID = '00000000-0000-4000-8000-000000000001';
export const CURRENT_SCHEMA_VERSION = 4;
export const canonicalPath = (path: string): string => { const absolute = resolve(path); try { return realpathSync.native(absolute); } catch { return absolute; } };
export const pathKey = (path: string): string => process.platform === 'win32' ? canonicalPath(path).toLocaleLowerCase('en-US') : canonicalPath(path);
/** Test-only fault injection for migration and backup failure paths. */
export interface StoreOptions { migrationFault?: 'after-ddl'; backupFault?: 'copy' | 'verify' }
export class Store {
  readonly db: Database.Database;
  readonly usage: UsageLedger;
  private schema: number;
  constructor(readonly path: string, private readonly options: StoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.usage = new UsageLedger(this.db, () => this.schema >= 4);
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > CURRENT_SCHEMA_VERSION) { this.db.close(); throw new Error('This database requires a newer application.'); }
    const fresh = version === 0 && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
    this.db.transaction(() => {
      this.db.exec(V1_SCHEMA);
      // Only a brand-new database is created at v4. Existing databases keep their
      // schema until the user confirms a verified, backed-up upgrade.
      if (fresh) { this.db.exec(V2_MIGRATION); this.db.exec(V3_MIGRATION); this.db.exec(PHASE4_SCHEMA); this.db.exec(V4_MIGRATION); this.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`); }
      else if (version === 0) this.db.pragma('user_version = 1');
      this.db.exec(PHASE4_SCHEMA);
      if (!this.profile(FAKE_PROFILE_ID)) this.saveProfile({ id: FAKE_PROFILE_ID, name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'deterministic-fixture', contextLimit: 32000, outputLimit: 2048 });
    })();
    this.schema = Number(this.db.pragma('user_version', { simple: true }));
    this.recover();
  }
  get schemaVersion(): number { return this.schema; }
  get orchestrationAvailable(): boolean { return this.schema >= 2; }
  beginUsage(...args: Parameters<UsageLedger['beginUsage']>): void { this.usage.beginUsage(...args); }
  attemptUsage(...args: Parameters<UsageLedger['attemptUsage']>): void { this.usage.attemptUsage(...args); }
  finishUsage(...args: Parameters<UsageLedger['finishUsage']>): boolean { return this.usage.finishUsage(...args); }
  hasUsage(...args: Parameters<UsageLedger['hasUsage']>): boolean { return this.schema >= 4 ? this.usage.hasUsage(...args) : !!this.db.prepare('SELECT 1 FROM usage_records WHERE request_id=?').get(args[0]); }
  usageSummary(params: { filters?: UsageFilters; timeZone?: string }) { return this.usage.summary(params); }
  usageBreakdown(params: { filters?: UsageFilters; groupBy: UsageGroup; sort?: 'tokens' | 'requests' | 'name'; cursor?: string; limit?: number }) { return this.usage.breakdown(params); }
  usageRequests(params: { filters?: UsageFilters; cursor?: string; limit?: number }) { return this.usage.requests(params); }
  close(): void { this.db.close(); }
  /** Compatibility for callers that explicitly need the published saved-projects v3 schema. */
  async upgradeToV3(backupDirectory = join(dirname(this.path), 'backups')): Promise<{ version: number; backupPath: string }> {
    if (this.schema !== 1 && this.schema !== 2) throw new Error(this.schema >= 3 ? 'The database is already current for v3.' : 'Unsupported database version for upgrade.');
    mkdirSync(backupDirectory, { recursive: true });
    const backupPath = join(backupDirectory, `workspace-v${this.schema}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.db`);
    if (this.options.backupFault === 'copy') throw new Error('Backup failed before the upgrade; the database was not changed.');
    await this.db.backup(backupPath);
    const expected = this.rowCounts(this.db);
    const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = copy.pragma('integrity_check', { simple: true });
      const copyVersion = Number(copy.pragma('user_version', { simple: true }));
      if (this.options.backupFault === 'verify' || integrity !== 'ok' || copyVersion !== this.schema || JSON.stringify(this.rowCounts(copy)) !== JSON.stringify(expected)) throw new Error('Backup verification failed; the database was not changed.');
    } finally { copy.close(); }
    this.db.transaction(() => {
      if (this.schema === 1) this.db.exec(V2_MIGRATION);
      this.db.exec(V3_MIGRATION);
      for (const task of this.allTasks()) {
        if (!isGitTask(task)) continue;
        const existing = this.projectByPath(task.projectPath);
        const project = existing ?? this.insertProject(canonicalPath(task.projectPath), 'git');
        if (project.kind !== 'git') this.saveProject({ ...project, kind: 'git' });
        this.saveTask({ ...task, workspaceKind: 'git', projectId: project.id });
      }
      if (this.options.migrationFault === 'after-ddl') throw new Error('Injected migration failure.');
      if ((this.db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key verification failed; migration rolled back.');
      this.db.pragma('user_version = 3');
    })();
    this.schema = Number(this.db.pragma('user_version', { simple: true }));
    const check = this.db.pragma('foreign_key_check') as unknown[];
    if (check.length) throw new Error('Foreign key verification failed after upgrade; retain the verified backup.');
    return { version: this.schema, backupPath };
  }
  /** Explicit, verified-backup upgrade from v1, v2 or the published projects v3 to v4. */
  async upgradeToCurrent(backupDirectory = join(dirname(this.path), 'backups')): Promise<{ version: number; backupPath: string }> {
    if (this.schema >= 4) throw new Error('The database is already current.');
    mkdirSync(backupDirectory, { recursive: true });
    const from = this.schema;
    const backupPath = join(backupDirectory, `workspace-v${from}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.db`);
    if (this.options.backupFault === 'copy') throw new Error('Backup failed before the upgrade; the database was not changed.');
    await this.db.backup(backupPath);
    const expected = this.rowCounts(this.db);
    const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      if (this.options.backupFault === 'verify' || copy.pragma('integrity_check', { simple: true }) !== 'ok' || Number(copy.pragma('user_version', { simple: true })) !== from || JSON.stringify(this.rowCounts(copy)) !== JSON.stringify(expected)) throw new Error('Backup verification failed; the database was not changed.');
    } finally { copy.close(); }
    this.db.transaction(() => {
      if (from === 1) this.db.exec(V2_MIGRATION);
      if (from < 3) {
        this.db.exec(V3_MIGRATION);
        for (const task of this.allTasks()) {
          if (!isGitTask(task)) continue;
          const existing = this.projectByPath(task.projectPath);
          const project = existing ?? this.insertProject(canonicalPath(task.projectPath), 'git');
          if (project.kind !== 'git') this.saveProject({ ...project, kind: 'git' });
          this.saveTask({ ...task, workspaceKind: 'git', projectId: project.id });
        }
      }
      this.db.exec(V4_MIGRATION);
      const old = this.db.prepare('SELECT * FROM usage_records ORDER BY rowid').all() as UsageRow[];
      const insert = this.db.prepare(`INSERT INTO provider_requests(request_id,task_id,root_task_id,parent_task_id,task_title,root_task_title,role,purpose,attribution_known,created_at,attempted_at,finished_at,outcome,reserved,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,usage_known,reason)
        VALUES(?,?,?,?,?,?,?,'legacy',0,?,?,?,'unknown',?,?,?,?,?,?,?)`);
      for (const row of old) {
        const task = this.task(row.task_id);
        const rootTitle = task.rootTaskId && task.rootTaskId !== task.id ? this.task(task.rootTaskId).title : task.title;
        insert.run(row.request_id, row.task_id, task.rootTaskId ?? row.task_id, task.parentTaskId ?? null, task.title, rootTitle, task.role ?? null, row.created_at, row.created_at, row.created_at, row.reserved, row.prompt_tokens, row.completion_tokens, row.cache_read_tokens, row.cache_creation_tokens, row.usage_known, row.reason);
      }
      const copied = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reserved),0) AS reserved, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM provider_requests').get() as { n: number; reserved: number; input: number; output: number };
      const original = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(reserved),0) AS reserved, COALESCE(SUM(prompt_tokens),0) AS input, COALESCE(SUM(completion_tokens),0) AS output FROM usage_records').get();
      if (JSON.stringify(copied) !== JSON.stringify(original)) throw new Error('Historical usage verification failed; migration rolled back.');
      if (this.options.migrationFault === 'after-ddl') throw new Error('Injected migration failure.');
      if ((this.db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key verification failed; migration rolled back.');
      this.db.pragma('user_version = 4');
    })();
    this.schema = 4;
    if ((this.db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key verification failed after upgrade; retain the verified backup.');
    return { version: 4, backupPath };
  }
  async upgradeToV2(backupDirectory?: string): Promise<{ version: number; backupPath: string }> { return this.upgradeToCurrent(backupDirectory); }
  private rowCounts(db: Database.Database): Record<string, number> {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const counts: Record<string, number> = {};
    for (const table of tables) {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS count FROM "${table.replace(/"/g, '""')}"`).get() as { count: number }).count;
    }
    if (counts.usage_records !== undefined) {
      const sums = db.prepare('SELECT COALESCE(SUM(reserved),0) AS reserved, COALESCE(SUM(prompt_tokens),0) AS input, COALESCE(SUM(completion_tokens),0) AS output FROM usage_records').get() as { reserved: number; input: number; output: number };
      counts.usage_reserved = sums.reserved; counts.usage_input = sums.input; counts.usage_output = sums.output;
    }
    return counts;
  }
  requireOrchestration(): void { if (!this.orchestrationAvailable) throw new Error('Coordinated tasks require the backed-up database upgrade. Upgrade from the workspace banner first.'); }
  requireProjects(): void { if (this.schema < 3) throw new Error('Saved projects require the backed-up database upgrade. Upgrade from the workspace banner first.'); }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  private parse<T>(row: unknown): T | undefined { return row ? JSON.parse((row as { data: string }).data) as T : undefined; }
  profile(id: string): ModelProfile | undefined { return this.parse<ModelProfile>(this.db.prepare('SELECT data FROM profiles WHERE id = ?').get(id)); }
  saveProfile(profile: ModelProfile): ModelProfile { this.db.prepare('INSERT OR REPLACE INTO profiles(id, data) VALUES (?, ?)').run(profile.id, JSON.stringify(profile)); return profile; }
  task(id: string): Task {
    const task = this.parse<Task>(this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id));
    if (!task) throw new Error('Task not found.');
    return task;
  }
  gitTask(id: string): GitTask { const task = this.task(id); if (!isGitTask(task)) throw new Error('This action requires a Git worktree.'); return task; }
  saveTask(task: Task): Task { this.db.prepare('INSERT OR REPLACE INTO tasks(id, data) VALUES (?, ?)').run(task.id, JSON.stringify(task)); return task; }
  projects(): Project[] { return this.schema < 3 ? [] : this.db.prepare('SELECT data FROM projects').all().map(row => this.parse<Project>(row)!); }
  project(id: string): Project | undefined { this.requireProjects(); return this.parse<Project>(this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id)); }
  projectByPath(path: string): Project | undefined { return this.parse<Project>(this.db.prepare('SELECT data FROM projects WHERE path_key = ?').get(pathKey(path))); }
  insertProject(path: string, kind: Project['kind'] = 'folder'): Project {
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), path, name: basename(path) || path, hidden: false, kind, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO projects(id, path_key, data) VALUES (?, ?, ?)').run(project.id, pathKey(path), JSON.stringify(project)); return project;
  }
  saveProject(project: Project): Project { this.requireProjects(); this.db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(project), project.id); return project; }
  preferences(): WorkspacePreferences {
    if (this.schema < 3) return { profileId: FAKE_PROFILE_ID, mode: 'chat', collapsedProjectIds: [] };
    return this.parse<WorkspacePreferences>(this.db.prepare('SELECT data FROM workspace_preferences WHERE id = 1').get()) ?? { profileId: FAKE_PROFILE_ID, mode: 'chat', collapsedProjectIds: [] };
  }
  savePreferences(preferences: WorkspacePreferences): WorkspacePreferences { this.requireProjects(); this.db.prepare('INSERT OR REPLACE INTO workspace_preferences(id, data) VALUES (1, ?)').run(JSON.stringify(preferences)); return preferences; }
  taskStart(requestId: string): { inputHash: string; taskId: string; state: 'pending' | 'unknown' | 'failed' | 'complete' } | undefined {
    this.requireProjects(); const row = this.db.prepare('SELECT input_hash, task_id, state FROM task_starts WHERE request_id = ?').get(requestId) as { input_hash: string; task_id: string; state: 'pending' | 'unknown' | 'failed' | 'complete' } | undefined;
    return row && { inputHash: row.input_hash, taskId: row.task_id, state: row.state };
  }
  reserveTaskStart(requestId: string, inputHash: string, taskId: string): void { this.db.prepare("INSERT INTO task_starts(request_id, input_hash, task_id, state, created_at) VALUES (?, ?, ?, 'pending', ?)").run(requestId, inputHash, taskId, new Date().toISOString()); }
  finishTaskStart(requestId: string, state: 'pending' | 'unknown' | 'failed' | 'complete'): void { this.db.prepare('UPDATE task_starts SET state = ? WHERE request_id = ?').run(state, requestId); }
  clearTaskStart(requestId: string): void { this.db.prepare('DELETE FROM task_starts WHERE request_id = ? AND state = ?').run(requestId, 'pending'); }
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
    if (this.schema >= 4) {
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM provider_requests WHERE task_id=? AND finished_at IS NOT NULL').get(taskId) as { n: number }).n;
      const rows = this.db.prepare('SELECT * FROM provider_requests WHERE task_id=? AND finished_at IS NOT NULL ORDER BY created_at DESC, request_id DESC LIMIT ?').all(taskId, limit) as Array<{ request_id: string; reserved: number; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null; usage_known: number; reason: string | null; created_at: string }>;
      return { total, records: rows.reverse().map(row => ({ id: row.request_id, taskId, requestId: row.request_id, reservedTokens: row.reserved, promptTokens: row.input_tokens, completionTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens, usageKnown: row.usage_known === 1, reason: row.reason, createdAt: row.created_at })) };
    }
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM usage_records WHERE task_id = ?').get(taskId) as { count: number }).count;
    const rows = this.db.prepare('SELECT * FROM usage_records WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(taskId, limit) as UsageRow[];
    return { total, records: rows.reverse().map(row => ({ id: row.id, taskId: row.task_id, requestId: row.request_id, reservedTokens: row.reserved, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens, usageKnown: row.usage_known === 1, reason: row.reason, createdAt: row.created_at })) };
  }
  usageTotals(taskId: string): { requests: number; knownRequests: number; unknownRequests: number; prompt: number; completion: number; cacheRead: number; cacheCreation: number; reservedUnknown: number } {
    if (this.schema >= 4) {
      const t = this.usage.summary({ filters: { taskId, includeChildren: false, includeDemo: true } }).totals;
      return { requests: t.requests, knownRequests: t.knownRequests, unknownRequests: t.unknownRequests + t.pendingRequests + t.notSentRequests, prompt: t.input, completion: t.output, cacheRead: t.cacheRead ?? 0, cacheCreation: t.cacheCreation ?? 0, reservedUnknown: t.reservedUnknown + t.reservedPending + t.reservedNotSent };
    }
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
      projects: this.projects().sort((a,b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
      preferences: this.preferences(),
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
      if (this.schema >= 4) continue;
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
      if (this.schema >= 4) this.usage.recover();
      this.db.prepare("UPDATE intents SET state = 'unknown' WHERE state = 'pending'").run();
      this.db.prepare("UPDATE intents SET state = 'revoked' WHERE kind = 'tool.approval' AND state IN ('awaiting-approval', 'approved')").run();
      this.db.prepare("UPDATE intents SET state = 'unknown' WHERE kind = 'tool.approval' AND state = 'executing'").run();
      if (this.schema >= 3) this.db.prepare("UPDATE task_starts SET state = 'unknown' WHERE state = 'pending'").run();
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
          if (this.schema < 4 && unrecorded > 0) {
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
