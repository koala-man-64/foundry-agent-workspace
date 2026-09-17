import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { V1_SCHEMA, V2_MIGRATION } from './schema';
import type { Approval, Message, ModelProfile, ProviderContinuation, ProviderToolResult, Snapshot, Task, TaskDetail, ToolCall, WorkspaceEvent } from '../../protocol/src/index';

export interface ProviderState { fingerprint: string; continuation: ProviderContinuation; pending: ToolCall[]; results: ProviderToolResult[]; seenToolCallIds?: string[]; }

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
    return { task: this.task(id), messages: this.db.prepare('SELECT data FROM messages WHERE task_id = ? ORDER BY ordinal').all(id).map(row => this.parse<Message>(row)!), approvals };
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
  intent(kind: string, data: unknown): string {
    const id = randomUUID(); this.db.prepare('INSERT INTO intents VALUES (?, ?, ?, ?)').run(id, kind, JSON.stringify(data), 'pending'); return id;
  }
  finishIntent(id: string, state: 'complete' | 'unknown'): void { this.db.prepare('UPDATE intents SET state = ? WHERE id = ?').run(state, id); }
  unknownIntents(): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM intents WHERE kind = 'worktree.create' AND state = 'unknown'").get() as { count: number }).count; }
  private recoverOrchestration(): void {
    const now = new Date().toISOString();
    // Interrupted requests keep their full conservative reservation; nothing is refunded.
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
        if (task.status !== 'running') continue;
        task.status = 'interrupted'; task.updatedAt = new Date().toISOString(); this.saveTask(task);
        for (const message of this.detail(task.id).messages) {
          if (message.status === 'streaming') this.saveMessage({ ...message, status: 'interrupted' });
        }
        this.event('task.interrupted', { reason: 'Runtime restarted; partial response retained. Reserved usage retained conservatively.' }, task.id);
      }
    });
  }
}
