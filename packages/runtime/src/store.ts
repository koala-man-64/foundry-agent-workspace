import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Approval, Message, ModelProfile, ProviderContinuation, ProviderToolResult, Snapshot, Task, TaskDetail, ToolCall, WorkspaceEvent } from '../../protocol/src/index';

export interface ProviderState { fingerprint: string; continuation: ProviderContinuation; pending: ToolCall[]; results: ProviderToolResult[]; seenToolCallIds?: string[]; }

export const FAKE_PROFILE_ID = '00000000-0000-4000-8000-000000000001';
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > 1) { this.db.close(); throw new Error('This database requires a newer application.'); }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL, ordinal INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, ordinal);
        CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
      if (!this.profile(FAKE_PROFILE_ID)) this.saveProfile({ id: FAKE_PROFILE_ID, name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'deterministic-fixture', contextLimit: 32000, outputLimit: 2048 });
    })();
    this.recover();
  }
  close(): void { this.db.close(); }
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
  snapshot(): Snapshot {
    return {
      tasks: this.db.prepare('SELECT data FROM tasks').all().map(row => this.parse<Task>(row)!).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)),
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
  private recover(): void {
    this.transaction(() => {
      this.db.prepare("UPDATE intents SET state = 'unknown' WHERE state = 'pending'").run();
      this.db.prepare("UPDATE intents SET state = 'revoked' WHERE kind = 'tool.approval' AND state IN ('awaiting-approval', 'approved')").run();
      this.db.prepare("UPDATE intents SET state = 'unknown' WHERE kind = 'tool.approval' AND state = 'executing'").run();
      for (const task of this.snapshot().tasks) {
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
