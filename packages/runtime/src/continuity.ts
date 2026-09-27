import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ContinuityRpc, isGitTask, type ArtifactPreview, type ContinuationPreview, type ContinuityView, type DecisionCard, type Message, type Task, type TaskLineage, type TaskTemplate, type TranscriptExport } from '../../protocol/src/index';
import { RepositoryError, type RepositoryService } from './repository';
import type { Redactor } from './redaction';
import type { Store } from './store';

type Method = keyof typeof ContinuityRpc;
type Preview = ContinuationPreview & { projectPath: string; sourcePath: string };
const CHUNK = 48 * 1024;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const isContinuityMethod = (method: string): method is Method => Object.hasOwn(ContinuityRpc, method);

/** Only selects visible records. Provider continuations and executable intents never enter this service's output. */
export class ContinuityService {
  private readonly previews = new Map<string, Preview>();
  private readonly artifacts = new Map<string, { value: ArtifactPreview; bytes: Buffer; expires: number }>();
  constructor(private readonly store: Store, private readonly repositories: RepositoryService, private readonly redactor: Redactor,
    private readonly publish: (type: string, data: unknown, taskId?: string) => void,
    private readonly options: { dataDirectory: string; profileReady: (id: string) => boolean; acquireSource: (taskId: string) => () => void }) {}

  async dispatch(method: Method, input: unknown): Promise<unknown> {
    if (this.store.schemaVersion < 5) throw new Error('Upgrade the database before using workspace continuity.');
    switch (method) {
      case 'templates.list': {
        const { after } = ContinuityRpc[method].parse(input);
        const rows = this.store.db.prepare('SELECT data FROM task_templates WHERE id>? ORDER BY id LIMIT 6').all(after ?? '') as { data: string }[];
        const items = rows.slice(0, 5).map(row => JSON.parse(row.data) as TaskTemplate); return { items, nextAfter: rows.length > 5 ? items.at(-1)!.id : null };
      }
      case 'templates.save': {
        const value = ContinuityRpc[method].parse(input);
        if (!this.store.profile(value.profileId)) throw new Error('Template profile no longer exists.');
        if (value.coordination && value.mode !== 'coordinated') throw new Error('Coordination settings require coordinated mode.');
        if (value.mode === 'coordinated' && !value.coordination) throw new Error('Configure the coordinator and validation requirements.');
        if (value.scope.some(path => !path || path.includes('..') || /^[\\/]|:/.test(path))) throw new Error('Template scope must contain relative repository paths.');
        this.screen(value, 'Template');
        if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) throw new Error('Template exceeds the 32 KiB configuration limit.');
        const count = this.store.db.prepare('SELECT COUNT(*) AS count FROM task_templates WHERE id <> ?').get(value.id) as { count: number };
        if (count.count >= 100) throw new Error('A workspace supports at most 100 templates. Remove an unused template first.');
        this.store.transaction(() => { this.store.db.prepare('INSERT INTO task_templates(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, JSON.stringify(value)); this.store.event('template.saved', { templateId: value.id }); });
        this.publish('templates.changed', {}); return value;
      }
      case 'templates.remove': {
        const { templateId } = ContinuityRpc[method].parse(input);
        const removed = this.store.db.prepare('DELETE FROM task_templates WHERE id=?').run(templateId).changes > 0;
        this.publish('templates.changed', {}); return { removed };
      }
      case 'continuity.get': {
        const p = ContinuityRpc[method].parse(input); this.store.task(p.taskId);
        const rows = this.store.db.prepare('SELECT rowid,data FROM decision_cards WHERE task_id=? AND rowid<? ORDER BY rowid DESC LIMIT 6').all(p.taskId, p.before ?? Number.MAX_SAFE_INTEGER) as { rowid: number; data: string }[];
        const lineage = this.store.db.prepare('SELECT data FROM task_lineage WHERE (task_id=? OR source_task_id=?) AND task_id>? ORDER BY task_id LIMIT 21').all(p.taskId, p.taskId, p.lineageAfter ?? '') as { data: string }[];
        const view: ContinuityView = { decisions: rows.slice(0, 5).map(row => JSON.parse(row.data) as DecisionCard), lineage: lineage.slice(0, 20).map(row => JSON.parse(row.data) as TaskLineage), nextBefore: rows.length > 5 ? rows[4]!.rowid : null, nextLineage: lineage.length > 20 ? (JSON.parse(lineage[19]!.data) as TaskLineage).taskId : null };
        return view;
      }
      case 'decision.save': {
        const p = ContinuityRpc[method].parse(input); this.store.task(p.taskId);
        this.messages(p.taskId, p.messageIds);
        for (const id of p.evidenceIds) {
          const intent = this.store.db.prepare("SELECT 1 FROM intents WHERE id=? AND json_extract(data,'$.taskId')=?").get(id, p.taskId);
          const event = /^event:\d+$/.test(id) && this.store.db.prepare('SELECT 1 FROM events WHERE sequence=? AND task_id=?').get(Number(id.slice(6)), p.taskId);
          if (!intent && !event) throw new Error('A selected evidence reference does not belong to this task.');
        }
        const card: DecisionCard = { ...p, id: randomUUID(), title: this.redactor.text(p.title), rationale: this.redactor.text(p.rationale), superseded: false, createdAt: new Date().toISOString() };
        if (Buffer.byteLength(JSON.stringify(card)) > 32 * 1024) throw new Error('Decision exceeds the 32 KiB record limit.');
        this.store.transaction(() => {
          if (p.supersedesId) {
            const row = this.store.db.prepare('SELECT data FROM decision_cards WHERE id=? AND task_id=?').get(p.supersedesId, p.taskId) as { data: string } | undefined;
            if (!row) throw new Error('The superseded decision does not belong to this task.');
            const prior = JSON.parse(row.data) as DecisionCard;
            if (prior.superseded) throw new Error('This decision was already superseded. Refresh the decision list.');
            this.store.db.prepare('UPDATE decision_cards SET data=? WHERE id=?').run(JSON.stringify({ ...prior, superseded: true }), prior.id);
          }
          this.store.db.prepare('INSERT INTO decision_cards(id,task_id,data,created_at) VALUES (?,?,?,?)').run(card.id, p.taskId, JSON.stringify(card), card.createdAt);
          this.store.event('decision.recorded', { decisionId: card.id, supersedesId: card.supersedesId }, p.taskId);
        });
        this.publish('continuity.changed', {}, p.taskId); return card;
      }
      case 'task.continuationPreview': {
        const p = ContinuityRpc[method].parse(input); const task = this.store.task(p.taskId); this.assertSettled(task);
        if (!isGitTask(task)) throw new Error('A Git project task is required for a worktree continuation.');
        const source = await this.repositories.continuationSource(task, p.sourceCommit);
        const context = this.context(task.id, p.messageIds, p.evidenceIds);
        if (Buffer.byteLength(context) > 64 * 1024) throw new Error('Selected context exceeds 64 KiB. Select fewer messages.');
        this.prune();
        const value: Preview = { id: randomUUID(), sourceTaskId: task.id, sourceCommit: source.commit, messageIds: p.messageIds, evidenceIds: p.evidenceIds, context, bytes: Buffer.byteLength(context), warnings: ['Selected messages and evidence metadata are copied as attributed context. Review the new task before sending.', 'Approvals, provider state, pending tool calls, credentials, and execution authority are excluded.'], expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), projectPath: task.projectPath, sourcePath: source.projectPath };
        const { projectPath: _project, sourcePath: _source, ...result } = value;
        if (Buffer.byteLength(JSON.stringify(result)) > 224 * 1024) throw new Error('Selected context exceeds the serialized preview limit. Select fewer messages.');
        this.previews.set(value.id, value); return result;
      }
      case 'task.continue': {
        const p = ContinuityRpc[method].parse(input); this.prune(); const preview = this.previews.get(p.previewId);
        if (!preview) throw new Error('Continuation preview expired. Preview the source again.');
        const release = this.options.acquireSource(preview.sourceTaskId);
        try {
        const task = this.store.task(preview.sourceTaskId); this.assertSettled(task);
        if (!isGitTask(task)) throw new Error('A Git project task is required for a worktree continuation.');
        if (!this.store.profile(p.profileId) || (p.mode === 'coding' && !this.options.profileReady(p.profileId))) throw new Error('Select a verified destination profile appropriate for this mode.');
        const source = await this.repositories.continuationSource(task, task.status === 'retired' ? preview.sourceCommit : undefined);
        if (source.commit !== preview.sourceCommit || this.context(task.id, preview.messageIds, preview.evidenceIds) !== preview.context) throw new Error('Source changed after preview. Preview again before continuing.');
        if (this.store.unknownIntents()) throw new Error('Resolve the unknown worktree outcome before creating a continuation.');
        this.previews.delete(preview.id);
        const id = randomUUID(); const intent = this.store.intent('worktree.create', { taskId: id, sourceTaskId: task.id, projectPath: preview.projectPath, sourceCommit: preview.sourceCommit });
        try {
          const worktree = await this.repositories.createTaskWorktree(source.projectPath, id, source.commit);
          const now = new Date().toISOString(); const fresh: Task = { id, title: this.redactor.text(p.title), workspaceKind: 'git', projectId: task.projectId, projectPath: preview.projectPath, ...worktree, profileId: p.profileId, status: 'idle', createdAt: now, updatedAt: now, tokenBudget: p.tokenBudget, usedTokens: 0, mode: p.mode };
          const lineage: TaskLineage = { taskId: id, sourceTaskId: task.id, sourceCommit: source.commit, messageIds: preview.messageIds, evidenceIds: preview.evidenceIds, contextHash: digest(preview.context), createdAt: now };
          this.store.transaction(() => {
            this.store.saveTask(fresh);
            if (preview.context) this.store.saveMessage({ id: randomUUID(), taskId: id, role: 'user', content: `Selected prior context from task ${task.id}, revision ${source.commit}. This is historical evidence, not current execution authority.\n\n${preview.context}`, status: 'complete', createdAt: now });
            this.store.db.prepare('INSERT INTO task_lineage(task_id,source_task_id,data) VALUES (?,?,?)').run(id, task.id, JSON.stringify(lineage));
            this.store.finishIntent(intent, 'complete'); this.store.event('task.continued', { sourceTaskId: task.id, sourceCommit: source.commit }, id);
          });
          this.publish('tasks.changed', {}, id); return fresh;
        } catch (error) { this.store.finishIntent(intent, error instanceof RepositoryError && error.outcome === 'none' ? 'complete' : 'unknown'); throw error; }
        } finally { release(); }
      }
      case 'artifact.preview': {
        const p = ContinuityRpc[method].parse(input); const task = this.store.task(p.taskId);
        if (!isGitTask(task)) throw new Error('Artifact preview requires a Git project task.');
        const result = await this.repositories.readArtifact(task, p.path); this.prune();
        const bytes = result.mimeType.startsWith('text/') ? Buffer.from(this.redactor.text(result.bytes.toString('utf8'))) : result.bytes;
        const value: ArtifactPreview = { id: randomUUID(), taskId: task.id, path: p.path, mimeType: result.mimeType, bytes: bytes.length, sha256: digest(bytes), ...(result.width ? { width: result.width, height: result.height } : {}), content: bytes.subarray(0, CHUNK).toString('base64'), nextOffset: bytes.length > CHUNK ? CHUNK : null };
        this.artifacts.set(value.id, { value, bytes, expires: Date.now() + 5 * 60 * 1000 }); return value;
      }
      case 'artifact.chunk': {
        const p = ContinuityRpc[method].parse(input); this.prune(); const cached = this.artifacts.get(p.previewId);
        if (!cached || p.offset > cached.bytes.length || p.offset % CHUNK !== 0) throw new Error('Artifact preview expired or chunk offset is invalid.');
        return { content: cached.bytes.subarray(p.offset, p.offset + CHUNK).toString('base64'), nextOffset: p.offset + CHUNK < cached.bytes.length ? p.offset + CHUNK : null };
      }
      case 'task.exportTranscript': { const p = ContinuityRpc[method].parse(input); return this.exportTranscript(p.taskId, p.includeChildren); }
    }
  }
  private screen(value: unknown, label: string): void { const text = JSON.stringify(value); if (this.redactor.text(text) !== text) throw new Error(`${label} contains sensitive values. Remove them before saving.`); }
  private messages(taskId: string, ids: string[]): Message[] {
    if (new Set(ids).size !== ids.length) throw new Error('Select each message once.');
    return ids.map(id => { const row = this.store.db.prepare('SELECT data FROM messages WHERE id=? AND task_id=?').get(id, taskId) as { data: string } | undefined;
      if (!row) throw new Error('Selected message does not belong to this task.'); const message = JSON.parse(row.data) as Message;
      if (!['user', 'assistant'].includes(message.role) || message.status !== 'complete') throw new Error('Only completed user-visible messages can be selected.'); return message; });
  }
  private context(taskId: string, ids: string[], evidenceIds: string[] = []): string {
    const messages = this.messages(taskId, ids).map(message => `[${message.role}; message ${message.id}; ${message.createdAt}]\n${this.redactor.text(message.content)}`);
    const evidence = evidenceIds.map(id => {
      if (/^event:\d+$/.test(id)) {
        const row = this.store.db.prepare('SELECT type,created_at,data FROM events WHERE sequence=? AND task_id=?').get(Number(id.slice(6)), taskId) as { type: string; created_at: string; data: string } | undefined;
        if (!row) throw new Error('A selected evidence reference does not belong to this task.');
        const data: unknown = JSON.parse(row.data);
        const metadata: Record<string, unknown> = { type: row.type, createdAt: row.created_at };
        // Recorded provenance only; never transfer a tool call, approval, nonce or opaque payload.
        if (data && typeof data === 'object' && !Array.isArray(data)) for (const field of ['state', 'status', 'assignmentId', 'revision', 'generation', 'evidenceId', 'validationId', 'passed', 'exitCode', 'cleanupVerified', 'head', 'tree', 'commit', 'integrationId']) {
          const value = (data as Record<string, unknown>)[field];
          if (typeof value === 'boolean' || typeof value === 'number') metadata[field] = value;
          else if (typeof value === 'string') metadata[field] = value.slice(0, 2048);
        }
        return `[Recorded evidence ${id}; source task ${taskId}; historical metadata only]\n${this.redactor.text(JSON.stringify(metadata))}`;
      }
      const row = this.store.db.prepare("SELECT kind,state,json_extract(data,'$.createdAt') AS created_at FROM intents WHERE id=? AND json_valid(data) AND json_extract(data,'$.taskId')=?").get(id, taskId) as { kind: string; state: string; created_at: string | null } | undefined;
      if (!row) throw new Error('A selected evidence reference does not belong to this task.');
      return `[Recorded evidence ${id}; source task ${taskId}; historical metadata only]\n${this.redactor.text(JSON.stringify({ kind: row.kind, state: row.state, createdAt: row.created_at }))}`;
    });
    return [...messages, ...evidence].join('\n\n');
  }
  private assertSettled(task: Task): void {
    const rootId = task.rootTaskId ?? task.id;
    const running = this.store.db.prepare("SELECT 1 FROM tasks WHERE (id=? OR parent_task_id=?) AND status='running' LIMIT 1").get(rootId, rootId);
    const unsettled = this.store.db.prepare("SELECT 1 FROM intents WHERE state IN ('pending','awaiting-approval','approved','executing','unknown') AND (json_extract(data,'$.taskId') IN (SELECT id FROM tasks WHERE id=? OR parent_task_id=?) OR json_extract(data,'$.rootTaskId')=?) LIMIT 1").get(rootId, rootId, rootId);
    if (running || unsettled) throw new Error('Source grouping has running, pending, or unknown execution. Resolve it before creating an independent continuation.');
  }
  private prune(): void {
    for (const [id, value] of this.previews) if (Date.parse(value.expiresAt) <= Date.now()) this.previews.delete(id);
    for (const [id, value] of this.artifacts) if (value.expires <= Date.now()) this.artifacts.delete(id);
    while (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    while (this.artifacts.size >= 8) this.artifacts.delete(this.artifacts.keys().next().value!);
  }
  private async exportTranscript(taskId: string, includeChildren: boolean): Promise<TranscriptExport> {
    this.store.task(taskId);
    const parent = join(this.options.dataDirectory, 'exports'); await mkdir(parent, { recursive: true });
    const id = randomUUID(); const temporary = join(parent, `.${id}.partial`); const destination = join(parent, `transcript-${id}`);
    await mkdir(temporary); let snapshot: Database.Database | undefined;
    const files: TranscriptExport['files'] = []; let messageCount = 0;
    const writers = new Map<string, Awaited<ReturnType<typeof open>>>();
    const hashes = new Map<string, ReturnType<typeof createHash>>(); const sizes = new Map<string, number>();
    const write = async (name: string, raw: string): Promise<void> => { const value = this.redactor.text(raw); let file = writers.get(name); if (!file) { file = await open(join(temporary, name), 'wx'); writers.set(name, file); hashes.set(name, createHash('sha256')); sizes.set(name, 0); } await file.writeFile(value); hashes.get(name)!.update(value); sizes.set(name, sizes.get(name)! + Buffer.byteLength(value)); };
    try {
      snapshot = new Database(this.store.path, { readonly: true, fileMustExist: true });
      snapshot.exec('BEGIN'); // A read snapshot on its own connection survives concurrent runtime writes.
      const source = snapshot.prepare('SELECT data FROM tasks WHERE id=?').get(taskId) as { data: string }; const selected = JSON.parse(source.data) as Task;
      const root = selected.rootTaskId ?? selected.id;
      const ids = includeChildren ? (snapshot.prepare('SELECT id FROM tasks WHERE id=? OR parent_task_id=? ORDER BY created_at,id').all(root, root) as { id: string }[]).map(row => row.id) : [taskId];
      await write('transcript.json', '{"format":"foundry-transcript","version":1,"tasks":[');
      let firstTask = true;
      for (const taskIdentity of ids) {
        const task = JSON.parse((snapshot.prepare('SELECT data FROM tasks WHERE id=?').get(taskIdentity) as { data: string }).data) as Task;
        const metadata = { id: task.id, title: task.title, mode: task.mode, role: task.role, rootTaskId: task.rootTaskId, createdAt: task.createdAt, archivedAt: task.archivedAt, status: task.status };
        await write('transcript.json', `${firstTask ? '' : ','}${JSON.stringify(metadata).slice(0, -1)},"messages":[`); firstTask = false;
        await write('transcript.md', `# ${task.title.replace(/[\r\n]/g, ' ')}\n\nTask: ${task.id}\n\n`);
        let firstMessage = true;
        for (const row of snapshot.prepare('SELECT data,ordinal FROM messages WHERE task_id=? ORDER BY ordinal').iterate(task.id) as Iterable<{ data: string; ordinal: number }>) {
          const message = JSON.parse(row.data) as Message;
          // Tool messages can retain sensitive or executable wire payloads and are excluded.
          if (!['user', 'assistant'].includes(message.role)) continue;
          const visible = { id: message.id, ordinal: row.ordinal, role: message.role, content: this.redactor.text(message.content), status: message.status, createdAt: message.createdAt };
          await write('transcript.json', `${firstMessage ? '' : ','}${JSON.stringify(visible)}`); firstMessage = false; messageCount++;
          await write('transcript.md', `## ${visible.role} · ${visible.createdAt}\n\n${visible.content}\n\n`);
        }
        const annotations = snapshot.prepare('SELECT id,from_ordinal,to_ordinal,summary,created_at FROM compactions WHERE task_id=? ORDER BY from_ordinal').iterate(task.id) as Iterable<Record<string, unknown>>;
        await write('transcript.json', '],"compactions":['); let comma = '';
        for (const annotation of annotations) { await write('transcript.json', comma + JSON.stringify(annotation)); await write('transcript.md', `> Compaction ${String(annotation.id)}: ${this.redactor.text(String(annotation.summary))}\n\n`); comma = ','; }
        const usage = snapshot.prepare('SELECT COUNT(*) AS requests, SUM(reserved) AS reserved, SUM(CASE WHEN usage_known=1 THEN prompt_tokens ELSE 0 END) AS observedPrompt, SUM(CASE WHEN usage_known=1 THEN completion_tokens ELSE 0 END) AS observedCompletion, SUM(CASE WHEN usage_known=0 THEN 1 ELSE 0 END) AS unknownRequests, SUM(cache_read_tokens) AS cacheRead, SUM(cache_creation_tokens) AS cacheCreation FROM usage_records WHERE task_id=?').get(task.id);
        const lineage = snapshot.prepare('SELECT data FROM task_lineage WHERE task_id=?').get(task.id) as { data: string } | undefined;
        await write('transcript.json', `],"usage":${JSON.stringify(usage)},"lineage":${lineage?.data ?? 'null'},"decisions":[`); comma = '';
        for (const row of snapshot.prepare('SELECT data FROM decision_cards WHERE task_id=? ORDER BY rowid').iterate(task.id) as Iterable<{ data: string }>) { await write('transcript.json', comma + row.data); comma = ','; }
        await write('transcript.json', ']}');
      }
      await write('transcript.json', ']}\n'); snapshot.exec('COMMIT');
      for (const [name, file] of writers) { await file.sync(); await file.close(); files.push({ name, bytes: sizes.get(name)!, sha256: hashes.get(name)!.digest('hex') }); }
      writers.clear();
      const manifest = JSON.stringify({ format: 'foundry-transcript-manifest', version: 1, createdAt: new Date().toISOString(), files }, null, 2);
      const manifestFile = await open(join(temporary, 'manifest.json'), 'wx'); try { await manifestFile.writeFile(manifest); await manifestFile.sync(); } finally { await manifestFile.close(); }
      await rename(temporary, destination); return { path: destination, files: [...files, { name: 'manifest.json', bytes: Buffer.byteLength(manifest), sha256: digest(manifest) }], messageCount };
    } catch (error) { for (const file of writers.values()) await file.close().catch(() => undefined); await rm(temporary, { recursive: true, force: true }); throw error;
    } finally { snapshot?.close(); }
  }
}
