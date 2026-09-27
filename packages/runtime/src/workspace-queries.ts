import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Approval, Message, ModelProfile, Project, Task, UsageRecord, WorkspaceEvent } from '../../protocol/src/index';
import type { z } from 'zod';
import { WorkspaceRpc, type ActionItem, type ActionPage, type ApprovalContentChunk, type ApprovalPage, type ApprovalRead, type CompactionContentChunk, type CompactionPage, type CompactionSummary, type EventPage, type MessageContentChunk, type MessagePage, type ProfilePage, type ProjectPage, type SearchCursor, type SearchHit, type TaskCursor, type TaskPage, type TimelinePage, type UsageRecordPage, type UsageTrendPage, type WorkspaceMethod } from '../../protocol/src/workspace';
import type { Redactor } from './redaction';
import { canonicalPath, type Store } from './store';

const PAGE_BYTES = 256 * 1024;
const PAGE_ITEMS_BYTES = PAGE_BYTES - 1024; // Leave room for cursors, counts, and response metadata.
const EXCERPT_BYTES = 4096;
type TaskRow = { data: string; created_at: string; updated_at: string; archived_at: string | null; id: string };
type MessageRow = { data: string; ordinal: number; id: string; task_id: string };
type EventRow = { sequence: number; type: string; task_id: string | null; data: string; created_at: string; version: number | null; source: string | null; root_task_id: string | null };

export function isWorkspaceMethod(method: string): method is WorkspaceMethod { return Object.prototype.hasOwnProperty.call(WorkspaceRpc, method); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function clipped(text: string, maxBytes = EXCERPT_BYTES): { content: string; truncated: boolean } {
  const source = Buffer.from(text, 'utf8');
  if (source.length <= maxBytes) return { content: text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
  return { content: source.subarray(0, end).toString('utf8'), truncated: true };
}
function boundedChunk<T>(source: Buffer, offset: number, maxBytes: number, build: (content: string, end: number) => T): T {
  let end = Math.min(source.length, offset + maxBytes);
  const align = (): void => { while (end < source.length && end > offset && (source[end]! & 0xc0) === 0x80) end--; };
  align();
  if (end === offset && end < source.length) end = Math.min(source.length, offset + 4);
  let result = build(source.subarray(offset, end).toString('utf8'), end);
  while (bytes(result) > PAGE_BYTES) {
    end = offset + Math.floor((end - offset) / 2);
    align();
    if (end <= offset) throw new Error('Content chunk cannot fit within the response limit.');
    result = build(source.subarray(offset, end).toString('utf8'), end);
  }
  return result;
}

/** Read projections and visibility operations. Source messages, provider state and approvals are never rewritten. */
export class WorkspaceQueries {
  constructor(private readonly store: Store, private readonly redactor: Redactor) {}

  dispatch(method: WorkspaceMethod, input: unknown): unknown {
    const params = WorkspaceRpc[method].parse(input);
    switch (method) {
      case 'workspace.summary': {
        const page = this.profiles(undefined, 25, 96 * 1024);
        const projectPage = this.projects(undefined, 25, 96 * 1024);
        const lastSequence = (this.store.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events').get() as { value: number }).value;
        return { profiles: page.profiles, nextProfileAfter: page.nextAfter, projects: projectPage.projects, nextProjectAfter: projectPage.nextAfter, preferences: this.store.preferences(), lastSequence, runtime: 'ready' as const };
      }
      case 'workspace.profiles': { const p = params as { after?: string; limit: number }; return this.profiles(p.after, p.limit); }
      case 'workspace.projects': { const p = params as { after?: string; limit: number }; return this.projects(p.after, p.limit); }
      case 'profile.read': { const row = this.store.db.prepare('SELECT data FROM profiles WHERE id=?').get((params as { profileId: string }).profileId) as { data: string } | undefined;
        if (!row) return null; const profile = JSON.parse(row.data) as ModelProfile;
        if (bytes(profile) > PAGE_BYTES) throw new Error('Stored profile is too large to read safely. Repair this profile before using it.');
        return profile;
      }
      case 'workspace.tasks': return this.tasks(params as z.output<typeof WorkspaceRpc['workspace.tasks']>);
      case 'workspace.search': return this.search(params as z.output<typeof WorkspaceRpc['workspace.search']>);
      case 'workspace.actions': return this.actions(params as { limit: number; cursor?: { tier: 0 | 1 | 2; at: string; id: string } });
      case 'workspace.events': return this.events(params as z.output<typeof WorkspaceRpc['workspace.events']>);
      case 'workspace.usageTrend': return this.usageTrend(params as z.output<typeof WorkspaceRpc['workspace.usageTrend']>);
      case 'task.timeline': return this.timeline(params as z.output<typeof WorkspaceRpc['task.timeline']>);
      case 'task.read': return this.read((params as { taskId: string }).taskId);
      case 'task.messages': return this.messages(params as z.output<typeof WorkspaceRpc['task.messages']>);
      case 'task.messageContent': return this.messageContent(params as z.output<typeof WorkspaceRpc['task.messageContent']>);
      case 'task.usageRecords': return this.usageRecords(params as z.output<typeof WorkspaceRpc['task.usageRecords']>);
      case 'task.compactions': return this.compactions(params as z.output<typeof WorkspaceRpc['task.compactions']>);
      case 'task.compactionContent': return this.compactionContent(params as z.output<typeof WorkspaceRpc['task.compactionContent']>);
      case 'task.approvals': return this.approvals(params as z.output<typeof WorkspaceRpc['task.approvals']>);
      case 'approval.get': return this.approval(params as { taskId: string; approvalId: string });
      case 'approval.content': return this.approvalContent(params as z.output<typeof WorkspaceRpc['approval.content']>);
      case 'task.setArchived': return this.setArchived(params as { taskId: string; archived: boolean });
    }
  }

  private profiles(after: string | undefined, limit: number, budget = 128 * 1024): ProfilePage {
    const rows = this.store.db.prepare('SELECT id,data FROM profiles WHERE id>? ORDER BY id LIMIT ?').all(after ?? '', limit + 1) as { id: string; data: string }[];
    const profiles: ModelProfile[] = [];
    for (const row of rows) {
      if (profiles.length >= limit) break;
      const profile = JSON.parse(row.data) as ModelProfile;
      if (bytes({ profiles: [...profiles, profile], nextAfter: row.id }) > budget) {
        if (!profiles.length) throw new Error('Stored profile is too large to page safely. Repair this profile before using it.');
        break;
      }
      profiles.push(profile);
    }
    return { profiles, nextAfter: rows.length > profiles.length ? profiles.at(-1)!.id : null };
  }

  private projects(after: string | undefined, limit: number, budget = 128 * 1024): ProjectPage {
    if (this.store.schemaVersion < 3) return { projects: [], nextAfter: null };
    const rows = this.store.db.prepare('SELECT id,data FROM projects WHERE id>? ORDER BY id LIMIT ?').all(after ?? '', limit + 1) as { id: string; data: string }[];
    const projects: Project[] = [];
    for (const row of rows) {
      if (projects.length >= limit) break;
      let project = JSON.parse(row.data) as Project;
      try {
        if (!statSync(project.path).isDirectory()) throw new Error('Folder unavailable.');
        const same = process.platform === 'win32' ? canonicalPath(project.path).toLowerCase() === project.path.toLowerCase() : canonicalPath(project.path) === project.path;
        if (!same) throw new Error('Folder now resolves to a different location.');
      } catch { project = { ...project, kind: 'unavailable', unavailableReason: 'Folder is unavailable.' }; }
      if (bytes({ projects: [...projects, project], nextAfter: row.id }) > budget) {
        if (!projects.length) throw new Error('Stored project is too large to page safely. Repair this project before using it.');
        break;
      }
      projects.push(project);
    }
    return { projects, nextAfter: rows.length > projects.length ? projects.at(-1)!.id : null };
  }

  private tasks(p: { visibility: 'active' | 'archived' | 'all'; sort: 'created' | 'recent'; limit: number; cursor?: TaskCursor; projectPath?: string; projectId?: string; mode?: string; status?: string; from?: string; to?: string }): TaskPage {
    const at = p.sort === 'created' ? 'created_at' : 'updated_at';
    const filterHash = fingerprint({ visibility: p.visibility, sort: p.sort, projectPath: p.projectPath ?? null, projectId: p.projectId ?? null, mode: p.mode ?? null, status: p.status ?? null, from: p.from ?? null, to: p.to ?? null });
    if (p.sort === 'recent' && p.cursor) throw new Error('Recent tasks are a refreshed first page; reload to see changes.');
    if (p.cursor && p.cursor.filterHash !== filterHash) throw new Error('Task list cursor belongs to different filters; reload the first page.');
    if (this.store.schemaVersion < 5) {
      const legacy = this.store.allTasks().filter(task => !task.parentTaskId && this.matchesTask(task, p));
      legacy.sort((a, b) => (p.sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)) || b.id.localeCompare(a.id));
      const highWater = p.cursor ? { at: p.cursor.highWaterAt, id: p.cursor.highWaterId } : { at: p.sort === 'created' ? legacy[0]?.createdAt ?? '' : legacy[0]?.updatedAt ?? '', id: legacy[0]?.id ?? '' };
      const filtered = legacy.filter(task => { const value = p.sort === 'created' ? task.createdAt : task.updatedAt; return !p.cursor || (value < p.cursor.at || value === p.cursor.at && task.id < p.cursor.id); });
      return this.taskPage(filtered.slice(0, p.limit + 1), p, highWater, filterHash);
    }
    const clauses = ['parent_task_id IS NULL']; const args: unknown[] = [];
    if (p.visibility !== 'all') clauses.push(p.visibility === 'active' ? 'archived_at IS NULL' : 'archived_at IS NOT NULL');
    if (p.projectPath) { clauses.push('project_path = ?'); args.push(p.projectPath); }
    if (p.projectId) { clauses.push('project_id = ?'); args.push(p.projectId); }
    if (p.mode) { clauses.push('mode = ?'); args.push(p.mode); }
    if (p.status) { clauses.push('status = ?'); args.push(p.status); }
    if (p.from) { clauses.push(`${at} >= ?`); args.push(p.from); }
    if (p.to) { clauses.push(`${at} <= ?`); args.push(p.to); }
    if (p.cursor) { clauses.push(`(${at} < ? OR (${at} = ? AND id < ?))`); args.push(p.cursor.at, p.cursor.at, p.cursor.id); }
    if (p.cursor) { clauses.push(`(${at} < ? OR (${at} = ? AND id <= ?))`); args.push(p.cursor.highWaterAt, p.cursor.highWaterAt, p.cursor.highWaterId); }
    const rows = this.store.db.prepare(`SELECT id, data, created_at, updated_at, archived_at FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY ${at} DESC, id DESC LIMIT ?`).all(...args, p.limit + 1) as TaskRow[];
    const highWater = p.cursor ? { at: p.cursor.highWaterAt, id: p.cursor.highWaterId } : { at: rows[0]?.[at] ?? '', id: rows[0]?.id ?? '' };
    return this.taskPage(rows.map(row => JSON.parse(row.data) as Task), p, highWater, filterHash);
  }
  private matchesTask(task: Task, p: { visibility: string; projectPath?: string; projectId?: string; mode?: string; status?: string; from?: string; to?: string; sort: string }): boolean {
    if (p.visibility === 'active' && task.archivedAt || p.visibility === 'archived' && !task.archivedAt) return false;
    if (p.projectPath && task.projectPath !== p.projectPath || p.projectId && task.projectId !== p.projectId || p.mode && (task.mode ?? 'chat') !== p.mode || p.status && task.status !== p.status) return false;
    const at = p.sort === 'created' ? task.createdAt : task.updatedAt;
    return !(p.from && at < p.from || p.to && at > p.to);
  }
  private taskPage(candidates: Task[], p: { visibility: 'active' | 'archived' | 'all'; sort: 'created' | 'recent'; limit: number }, highWater: { at: string; id: string }, filterHash: string): TaskPage {
    const tasks: Task[] = [];
    for (const task of candidates.slice(0, p.limit)) {
      if (bytes({ tasks: [...tasks, task] }) > PAGE_ITEMS_BYTES) {
        if (!tasks.length) throw new Error('Stored task is too large to page safely.');
        break;
      }
      tasks.push(task);
    }
    const last = tasks.at(-1);
    return { tasks, nextCursor: p.sort === 'created' && last && (candidates.length > tasks.length) ? { at: last.createdAt, id: last.id, highWaterAt: highWater.at, highWaterId: highWater.id, filterHash } : null, visibility: p.visibility };
  }
  private mapEvent(row: EventRow): WorkspaceEvent {
    let data: unknown = { redacted: true };
    if (Buffer.byteLength(row.data, 'utf8') <= 4096) {
      try { const redacted = this.redactor.text(row.data); data = Buffer.byteLength(redacted, 'utf8') <= 4096 ? JSON.parse(redacted) as unknown : { truncated: true }; } catch { /* malformed or unsafe historical data is not displayed */ }
    } else data = { truncated: true };
    const runtime = row.version === 1 && row.source === 'runtime';
    return { sequence: row.sequence, type: row.type, taskId: row.task_id ?? undefined, rootTaskId: row.root_task_id ?? undefined,
      data, createdAt: row.created_at, version: 1, source: runtime ? 'runtime' : 'legacy', ...(runtime ? {} : { legacy: true as const }) };
  }

  private messages(p: { taskId: string; before?: number; through?: number; limit: number }): MessagePage {
    this.store.task(p.taskId);
    const max = (this.store.db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS value FROM messages WHERE task_id = ?').get(p.taskId) as { value: number }).value;
    const through = Math.min(p.through ?? max, max);
    const rows = this.store.db.prepare('SELECT id, task_id, data, ordinal FROM messages WHERE task_id = ? AND ordinal <= ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?')
      .all(p.taskId, through, p.before ?? through + 1, p.limit + 1) as MessageRow[];
    const items: MessagePage['items'] = [];
    for (const row of rows.slice(0, p.limit)) {
      const original = JSON.parse(row.data) as Message;
      const excerpt = clipped(this.redactor.text(original.content));
      const item = { message: { ...original, id: row.id, content: excerpt.content, ...(excerpt.truncated ? { truncated: true } : {}) }, ordinal: row.ordinal };
      if (bytes({ items: [...items, item] }) > PAGE_ITEMS_BYTES) {
        if (!items.length) throw new Error('Stored message metadata is too large to page safely.');
        break;
      }
      items.push(item);
    }
    const oldest = items.at(-1)?.ordinal;
    return { items: items.reverse(), nextBefore: oldest !== undefined && rows.length > items.length ? oldest : null, through };
  }
  private messageContent(p: { taskId: string; messageId: string; offset: number; maxBytes: number }): MessageContentChunk {
    const row = this.store.db.prepare('SELECT data FROM messages WHERE id = ? AND task_id = ?').get(p.messageId, p.taskId) as { data: string } | undefined;
    if (!row) throw new Error('Message not found in this task.');
    const message = JSON.parse(row.data) as Message;
    const source = Buffer.from(this.redactor.text(message.content), 'utf8');
    if (p.offset > source.length) throw new Error('Message offset is beyond the content.');
    return boundedChunk(source, p.offset, p.maxBytes, (content, end) =>
      ({ messageId: p.messageId, content, offset: p.offset, nextOffset: end < source.length ? end : null, totalBytes: source.length }));
  }

  private usageRecords(p: { taskId: string; before?: number; limit: number }): UsageRecordPage {
    const task = this.store.task(p.taskId);
    type Row = { rowid: number; id?: string; task_id: string; request_id: string; reserved: number; prompt_tokens?: number | null; completion_tokens?: number | null; input_tokens?: number | null; output_tokens?: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null; usage_known: number; reason: string | null; created_at: string; outcome?: UsageRecord['outcome']; attempted_at?: string | null };
    const current = this.store.schemaVersion >= 4;
    const includeChildren = current && task.mode === 'coordinated' && !task.parentTaskId;
    const rows = (current
      ? this.store.db.prepare(`SELECT rowid, * FROM provider_requests WHERE ${includeChildren ? 'root_task_id' : 'task_id'} = ? AND finished_at IS NOT NULL AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
      : this.store.db.prepare('SELECT rowid, * FROM usage_records WHERE task_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?'))
      .all(p.taskId, p.before ?? Number.MAX_SAFE_INTEGER, p.limit + 1) as Row[];
    const selected: UsageRecord[] = [];
    for (const row of rows.slice(0, p.limit)) {
      const record = { id: current ? row.request_id : row.id!, taskId: row.task_id, requestId: row.request_id, reservedTokens: row.reserved,
        promptTokens: current ? row.input_tokens ?? null : row.prompt_tokens ?? null, completionTokens: current ? row.output_tokens ?? null : row.completion_tokens ?? null, cacheReadTokens: row.cache_read_tokens,
        cacheCreationTokens: row.cache_creation_tokens, usageKnown: row.usage_known === 1,
        reason: row.reason ? clipped(this.redactor.text(row.reason), 1000).content : null, createdAt: row.created_at,
        ...(current ? { outcome: row.outcome, attemptedAt: row.attempted_at ?? null } : {}) } satisfies UsageRecord;
      if (bytes({ records: [...selected, record] }) > PAGE_ITEMS_BYTES) {
        if (!selected.length) throw new Error('Stored usage record is too large to page safely.');
        break;
      }
      selected.push(record);
    }
    return { records: selected, nextBefore: rows.length > selected.length ? rows[selected.length - 1]!.rowid : null };
  }

  private compactions(p: { taskId: string; before?: number; limit: number }): CompactionPage {
    this.store.task(p.taskId);
    const rows = this.store.db.prepare('SELECT rowid, id, task_id, from_ordinal, to_ordinal, json_array_length(message_ids) AS message_count, summary, estimated_before, estimated_after, created_at FROM compactions WHERE task_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?')
      .all(p.taskId, p.before ?? Number.MAX_SAFE_INTEGER, p.limit + 1) as ({ rowid: number; id: string; task_id: string; from_ordinal: number; to_ordinal: number; message_count: number; summary: string; estimated_before: number; estimated_after: number; created_at: string })[];
    const selected: CompactionSummary[] = [];
    for (const row of rows.slice(0, p.limit)) {
      const excerpt = clipped(this.redactor.text(row.summary), 2000);
      const summary = { id: row.id, taskId: row.task_id, fromOrdinal: row.from_ordinal, toOrdinal: row.to_ordinal,
        messageCount: row.message_count, summaryExcerpt: excerpt.content, summaryTruncated: excerpt.truncated,
        estimatedTokensBefore: row.estimated_before, estimatedTokensAfter: row.estimated_after, createdAt: row.created_at };
      if (bytes({ compactions: [...selected, summary] }) > PAGE_ITEMS_BYTES) {
        if (!selected.length) throw new Error('Stored compaction marker is too large to page safely.');
        break;
      }
      selected.push(summary);
    }
    return { compactions: selected, nextBefore: rows.length > selected.length ? rows[selected.length - 1]!.rowid : null };
  }

  private compactionContent(p: { taskId: string; compactionId: string; offset: number; maxBytes: number }): CompactionContentChunk {
    const row = this.store.db.prepare('SELECT summary FROM compactions WHERE id = ? AND task_id = ?').get(p.compactionId, p.taskId) as { summary: string } | undefined;
    if (!row) throw new Error('Compaction not found in this task.');
    const source = Buffer.from(this.redactor.text(row.summary), 'utf8');
    if (p.offset > source.length) throw new Error('Compaction offset is beyond the content.');
    return boundedChunk(source, p.offset, p.maxBytes, (content, end) =>
      ({ compactionId: p.compactionId, content, offset: p.offset, nextOffset: end < source.length ? end : null, totalBytes: source.length }));
  }

  private usageTrend(p: { groupBy: 'day' | 'profile' | 'task'; from?: string; to?: string; profileId?: string; taskId?: string; after?: string; limit: number }): UsageTrendPage {
    const from = p.from ?? '1970-01-01T00:00:00.000Z', to = p.to ?? new Date().toISOString();
    if (from > to) throw new Error('Usage trend start must be before end.');
    const current = this.store.schemaVersion >= 4;
    const group = p.groupBy === 'day' ? 'substr(u.created_at, 1, 10)' : p.groupBy === 'profile'
      ? current ? "COALESCE(u.profile_id, 'unknown')" : "COALESCE(json_extract(t.data, '$.profileId'), 'unknown')" : current ? 'COALESCE(u.root_task_id, u.task_id)' : 'u.task_id';
    const known = current ? "u.outcome != 'pending' AND u.usage_known = 1" : 'u.usage_known = 1';
    const pending = current ? "u.outcome = 'pending'" : '0';
    const notSent = current ? "u.outcome != 'pending' AND u.usage_known = 0 AND u.attribution_known = 1 AND u.attempted_at IS NULL" : '0';
    const unknown = current ? `u.outcome != 'pending' AND u.usage_known = 0 AND NOT (${notSent})` : 'u.usage_known = 0';
    const profile = current ? 'u.profile_id' : "json_extract(t.data, '$.profileId')";
    const selected = p.taskId ? this.store.task(p.taskId) : undefined;
    const includeChildren = current && selected?.mode === 'coordinated' && !selected.parentTaskId;
    const taskFilter = includeChildren ? 'u.root_task_id' : 'u.task_id';
    const table = current ? 'provider_requests' : 'usage_records';
    const join = current ? '' : 'JOIN tasks t ON t.id = u.task_id';
    const rows = this.store.db.prepare(`SELECT ${group} AS key, COUNT(*) AS requests,
      SUM(CASE WHEN ${known} THEN 1 ELSE 0 END) AS known,
      SUM(CASE WHEN ${pending} THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN ${notSent} THEN 1 ELSE 0 END) AS not_sent,
      SUM(CASE WHEN ${unknown} THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN ${known} THEN COALESCE(u.${current ? 'input_tokens' : 'prompt_tokens'}, 0) ELSE 0 END) AS prompt,
      SUM(CASE WHEN ${known} THEN COALESCE(u.${current ? 'output_tokens' : 'completion_tokens'}, 0) ELSE 0 END) AS completion,
      SUM(COALESCE(u.cache_read_tokens, 0)) AS cache_read,
      SUM(COALESCE(u.cache_creation_tokens, 0)) AS cache_creation,
      SUM(CASE WHEN ${unknown} THEN u.reserved ELSE 0 END) AS reserved_unknown,
      SUM(CASE WHEN ${pending} THEN u.reserved ELSE 0 END) AS reserved_pending,
      SUM(CASE WHEN ${notSent} THEN u.reserved ELSE 0 END) AS reserved_not_sent
      FROM ${table} u ${join}
      WHERE u.created_at >= ? AND u.created_at <= ? AND (? IS NULL OR ${taskFilter} = ?)
        AND (? IS NULL OR ${profile} = ?) ${p.groupBy === 'task' ? 'AND u.task_id IS NOT NULL' : ''}
      GROUP BY key HAVING key > ? ORDER BY key LIMIT ?`)
      .all(from, to, p.taskId ?? null, p.taskId ?? null, p.profileId ?? null, p.profileId ?? null, p.after ?? '', p.limit + 1) as { key: string; requests: number; known: number; pending: number; not_sent: number; unknown: number; prompt: number; completion: number; cache_read: number; cache_creation: number; reserved_unknown: number; reserved_pending: number; reserved_not_sent: number }[];
    const buckets = rows.slice(0, p.limit).map(row => ({ key: row.key, requests: row.requests, knownRequests: row.known,
      unknownRequests: row.unknown, pendingRequests: row.pending, notSentRequests: row.not_sent,
      observedPrompt: row.prompt, observedCompletion: row.completion, cacheRead: row.cache_read,
      cacheCreation: row.cache_creation, reservedUnknown: row.reserved_unknown,
      reservedPending: row.reserved_pending, reservedNotSent: row.reserved_not_sent }));
    return { groupBy: p.groupBy, buckets, nextAfter: rows.length > p.limit ? buckets.at(-1)!.key : null, timeZone: 'UTC' };
  }

  private read(taskId: string): { task: Task; compactionCount: number; pendingApprovals: number; unknownOutcomes: number } {
    const task = this.store.task(taskId);
    const compactionCount = (this.store.db.prepare('SELECT COUNT(*) AS count FROM compactions WHERE task_id = ?').get(taskId) as { count: number }).count;
    const counts = this.store.db.prepare(`SELECT
      SUM(CASE WHEN kind = 'tool.approval' AND state = 'awaiting-approval' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END) AS unknown
      FROM intents WHERE json_valid(data) AND json_extract(data, '$.taskId') = ?
      AND (kind = 'tool.approval' OR kind IN ('git.push','git.commit','worktree.retire'))`).get(taskId) as { pending: number | null; unknown: number | null };
    return { task, compactionCount, pendingApprovals: counts.pending ?? 0, unknownOutcomes: counts.unknown ?? 0 };
  }
  private approvals(p: { taskId: string; limit: number; before?: number }): ApprovalPage {
    this.store.task(p.taskId);
    const filtered = this.store.db.prepare("SELECT rowid, data, state FROM intents WHERE kind = 'tool.approval' AND rowid < ? AND json_valid(data) AND json_extract(data, '$.taskId') = ? ORDER BY rowid DESC LIMIT ?")
      .all(p.before ?? Number.MAX_SAFE_INTEGER, p.taskId, p.limit + 1) as { rowid: number; data: string; state: Approval['state'] }[];
    const selected = filtered.slice(0, p.limit).map(row => { const value = JSON.parse(row.data) as Approval; return { id: value.id, taskId: value.taskId, tool: value.tool, state: row.state, createdAt: value.createdAt, path: value.path }; });
    return { approvals: selected, nextBefore: filtered.length > selected.length ? filtered[selected.length - 1]!.rowid : null };
  }
  private approvalValue(p: { taskId: string; approvalId: string }): Approval {
    const value = this.store.approval(p.approvalId);
    if (value.taskId !== p.taskId) throw new Error('Approval not found in this task.');
    return value;
  }
  private approvalText(p: { taskId: string; approvalId: string }): { value: Approval; full: string; redacted: boolean } {
    const value = this.approvalValue(p);
    const raw = JSON.stringify(value), full = this.redactor.text(raw);
    try { return { value: JSON.parse(full) as Approval, full, redacted: full !== raw }; }
    catch { throw new Error('Approval evidence could not be safely rendered.'); }
  }
  private approval(p: { taskId: string; approvalId: string }): ApprovalRead {
    const { value, full, redacted } = this.approvalText(p);
    const fullBytes = Buffer.byteLength(full, 'utf8');
    if (fullBytes <= 128 * 1024) return { approval: value, truncatedFields: [], fullBytes, redacted };
    const summary = clipped(value.summary, 1000);
    const preview: Approval = { id: value.id, taskId: value.taskId, toolCallId: value.toolCallId, nonce: value.nonce,
      tool: value.tool, state: value.state, createdAt: value.createdAt, summary: summary.content, fingerprint: value.fingerprint,
      ...(value.origin ? { origin: value.origin } : {}), ...(value.path ? { path: clipped(value.path, 1000).content } : {}),
      ...(value.expectedHash !== undefined ? { expectedHash: value.expectedHash } : {}),
      ...(value.resultingHash !== undefined ? { resultingHash: value.resultingHash } : {}),
      ...(value.rootTaskId ? { rootTaskId: value.rootTaskId } : {}), ...(value.assignmentId !== undefined ? { assignmentId: value.assignmentId } : {}),
      ...(value.generation !== undefined ? { generation: value.generation } : {}), ...(value.evidenceId ? { evidenceId: value.evidenceId } : {}) };
    const truncatedFields = ['full', ...(['summary','before','after','command','result','handoff','integration','mcp','environment'] as const)
      .filter(field => field === 'summary' ? summary.truncated : value[field] !== undefined)];
    return { approval: preview, truncatedFields, fullBytes, redacted };
  }
  private approvalContent(p: { taskId: string; approvalId: string; field: string; offset: number; maxBytes: number }): ApprovalContentChunk {
    const { value, full } = this.approvalText(p);
    const fields: Record<string, string | undefined> = { full, summary: value.summary, before: value.before, after: value.after,
      command: value.command, 'result.content': value.result?.content, 'handoff.patch': value.handoff?.patch,
      'integration.patch': value.integration?.patch, 'mcp.arguments': value.mcp?.arguments };
    const selected = fields[p.field];
    if (selected === undefined) throw new Error('Approval content field is absent.');
    const source = Buffer.from(selected, 'utf8');
    if (p.offset > source.length) throw new Error('Approval content offset is beyond the field.');
    let end = Math.min(source.length, p.offset + p.maxBytes);
    while (end < source.length && end > p.offset && (source[end]! & 0xc0) === 0x80) end--;
    if (end === p.offset && end < source.length) end = Math.min(source.length, p.offset + 4);
    return { approvalId: p.approvalId, field: p.field, content: source.subarray(p.offset, end).toString('utf8'),
      offset: p.offset, nextOffset: end < source.length ? end : null, totalBytes: source.length };
  }
  private setArchived(p: { taskId: string; archived: boolean }): Task {
    return this.store.transaction(() => {
      const task = this.store.task(p.taskId);
      if (task.parentTaskId) throw new Error('Archive the coordinated root, not an individual child.');
      const archivedAt = p.archived ? task.archivedAt ?? new Date().toISOString() : undefined;
      const saved = this.store.saveTask({ ...task, archivedAt });
      if (this.store.schemaVersion >= 5 && task.mode === 'coordinated') {
        for (const row of this.store.db.prepare('SELECT data FROM tasks WHERE parent_task_id = ?').all(task.id) as { data: string }[]) {
          const child = JSON.parse(row.data) as Task;
          this.store.saveTask({ ...child, archivedAt });
        }
      }
      return saved;
    });
  }

  private search(p: { query: string; visibility: 'active' | 'archived' | 'all'; limit: number; cursor?: SearchCursor; projectPath?: string; projectId?: string; mode?: string; status?: string; from?: string; to?: string }): { hits: SearchHit[]; nextCursor: SearchCursor | null } {
    const filterHash = fingerprint({ query: p.query, visibility: p.visibility, projectPath: p.projectPath ?? null, projectId: p.projectId ?? null, mode: p.mode ?? null, status: p.status ?? null, from: p.from ?? null, to: p.to ?? null });
    if (p.cursor && p.cursor.filterHash !== filterHash) throw new Error('Search cursor belongs to different filters; restart the search.');
    const throughOrdinal = p.cursor?.throughOrdinal ?? (this.store.db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS value FROM messages').get() as { value: number }).value;
    const taskThroughRowid = p.cursor?.taskThroughRowid ?? (this.store.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM tasks').get() as { value: number }).value;
    const baseCursor = { throughOrdinal, taskThroughRowid, filterHash };
    const hits: SearchHit[] = [];
    if (!p.cursor || p.cursor.phase === 'titles') {
      const after = p.cursor?.titleAfter;
      let remaining: Task[];
      if (this.store.schemaVersion >= 5) {
        const clauses = ["parent_task_id IS NULL", 'rowid <= ?', "instr(lower(json_extract(data, '$.title')), lower(?)) > 0"];
        const args: unknown[] = [taskThroughRowid, p.query];
        if (p.visibility !== 'all') clauses.push(p.visibility === 'active' ? 'archived_at IS NULL' : 'archived_at IS NOT NULL');
        if (p.projectPath) { clauses.push('project_path = ?'); args.push(p.projectPath); }
        if (p.projectId) { clauses.push('project_id = ?'); args.push(p.projectId); }
        if (p.mode) { clauses.push('mode = ?'); args.push(p.mode); }
        if (p.status) { clauses.push('status = ?'); args.push(p.status); }
        if (p.from) { clauses.push('created_at >= ?'); args.push(p.from); }
        if (p.to) { clauses.push('created_at <= ?'); args.push(p.to); }
        if (after) { clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(after.at, after.at, after.id); }
        remaining = (this.store.db.prepare(`SELECT data FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
          .all(...args, p.limit + 1) as { data: string }[]).map(row => JSON.parse(row.data) as Task);
      } else {
        const titles = (this.store.db.prepare('SELECT data FROM tasks WHERE rowid <= ?').all(taskThroughRowid) as { data: string }[]).map(row => JSON.parse(row.data) as Task)
          .filter(item => !item.parentTaskId && this.matchesTask(item, { ...p, sort: 'created' }) && item.title.toLocaleLowerCase().includes(p.query.toLocaleLowerCase()))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        remaining = after ? titles.filter(item => item.createdAt < after.at || item.createdAt === after.at && item.id < after.id).slice(0, p.limit + 1) : titles.slice(0, p.limit + 1);
      }
      for (const task of remaining.slice(0, p.limit)) hits.push({ taskId: task.id, rootTaskId: task.id, taskTitle: task.title, excerpt: task.title, createdAt: task.createdAt });
      if (remaining.length > hits.length) {
        const last = remaining[hits.length - 1]!;
        return { hits, nextCursor: { ...baseCursor, phase: 'titles', titleAfter: { at: last.createdAt, id: last.id } } };
      }
      if (hits.length === p.limit && throughOrdinal > 0 && this.store.schemaVersion >= 5)
        return { hits, nextCursor: { ...baseCursor, phase: 'messages', beforeOrdinal: throughOrdinal + 1 } };
    }
    if (this.store.schemaVersion < 5 || throughOrdinal === 0) return { hits, nextCursor: null };
    const tokens = p.query.split(/\s+/).filter(Boolean).slice(0, 8).map(token => `"${token.replace(/"/g, '""')}"`).join(' AND ');
    const clauses = ['messages_fts MATCH ?', 'm.ordinal <= ?', 'm.ordinal < ?'];
    const args: unknown[] = [tokens, throughOrdinal, p.cursor?.beforeOrdinal ?? throughOrdinal + 1];
    if (p.projectPath) { clauses.push('root.project_path = ?'); args.push(p.projectPath); }
    if (p.projectId) { clauses.push('root.project_id = ?'); args.push(p.projectId); }
    if (p.mode) { clauses.push('root.mode = ?'); args.push(p.mode); }
    if (p.status) { clauses.push('root.status = ?'); args.push(p.status); }
    if (p.from) { clauses.push('root.created_at >= ?'); args.push(p.from); }
    if (p.to) { clauses.push('root.created_at <= ?'); args.push(p.to); }
    if (p.visibility !== 'all') clauses.push(p.visibility === 'active' ? 'root.archived_at IS NULL' : 'root.archived_at IS NOT NULL');
    const remainingSlots = p.limit - hits.length;
    const rows = this.store.db.prepare(`SELECT m.id, m.task_id, m.data, m.ordinal, root.data AS root_data FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid JOIN tasks t ON t.id = m.task_id
      JOIN tasks root ON root.id = COALESCE(t.parent_task_id, t.id)
      WHERE ${clauses.join(' AND ')} ORDER BY m.ordinal DESC LIMIT ?`).all(...args, remainingSlots + 1) as (MessageRow & { root_data: string })[];
    for (const row of rows.slice(0, remainingSlots)) {
      const message = JSON.parse(row.data) as Message, task = JSON.parse(row.root_data) as Task;
      hits.push({ taskId: row.task_id, rootTaskId: task.id, taskTitle: task.title, messageId: row.id, ordinal: row.ordinal, role: message.role,
        excerpt: clipped(this.redactor.text(message.content), 500).content, createdAt: message.createdAt });
    }
    const lastOrdinal = hits.filter(hit => hit.ordinal !== undefined).at(-1)?.ordinal;
    return { hits, nextCursor: rows.length > remainingSlots && lastOrdinal !== undefined ? { ...baseCursor, phase: 'messages', beforeOrdinal: lastOrdinal } : null };
  }

  private actions(p: { limit: number; cursor?: { tier: 0 | 1 | 2; at: string; id: string } }): ActionPage {
    // Select only a bounded page in SQLite. The JSON columns remain authoritative for
    // intents and drafts; the indexed task columns are a read projection.
    const v3 = this.store.schemaVersion >= 5;
    const taskRef = (column: string): string => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.taskId') END`;
    const approvalAt = "CASE WHEN json_valid(i.data) THEN json_extract(i.data, '$.createdAt') END";
    const candidates = [
      `SELECT 'approval:' || i.id AS id, 'approval' AS kind, i.id AS source_id, i.state, ${taskRef('i.data')} AS source_task_id,
        COALESCE(${approvalAt}, '1970-01-01T00:00:00.000Z') AS at, 'Reviewed tool action' AS detail
       FROM intents i WHERE i.kind = 'tool.approval' AND i.state IN ('awaiting-approval','approved','executing','unknown')`,
      `SELECT 'intent:' || i.id, 'intent', i.id, i.state,
        CASE WHEN json_valid(i.data) THEN COALESCE(json_extract(i.data, '$.taskId'), json_extract(i.data, '$.rootTaskId')) END,
        COALESCE(CASE WHEN json_valid(i.data) THEN json_extract(i.data, '$.createdAt') END, '1970-01-01T00:00:00.000Z'), i.kind
       FROM intents i WHERE i.kind <> 'tool.approval' AND i.state = 'unknown'`
    ];
    if (v3) {
      candidates.push(
        `SELECT 'task:' || t.id, 'task', t.id, t.status, t.id, t.updated_at, 'Task running'
         FROM tasks t WHERE t.status = 'running' AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.task_id = t.id)`,
        `SELECT 'run:' || r.task_id, 'run', r.task_id, r.lifecycle, r.task_id, r.updated_at, COALESCE(r.wait_reason, 'Active agent run')
         FROM agent_runs r WHERE r.lifecycle <> 'terminal'`,
        `SELECT 'validation:' || v.id, 'validation', v.id, 'failed', v.run_task_id, v.created_at, 'Validation needs review'
         FROM validation_evidence v WHERE v.passed = 0 AND NOT EXISTS (
           SELECT 1 FROM validation_evidence newer WHERE newer.run_task_id = v.run_task_id AND newer.kind = v.kind
           AND (newer.created_at > v.created_at OR (newer.created_at = v.created_at AND newer.id > v.id)))`,
        `SELECT 'draft:' || d.id, 'draft', d.id, 'open', ${taskRef('d.data')},
           COALESCE(CASE WHEN json_valid(d.data) THEN json_extract(d.data, '$.createdAt') END, '1970-01-01T00:00:00.000Z'),
           CASE WHEN json_valid(d.data) THEN json_extract(d.data, '$.kind') END FROM automation_drafts d
         WHERE CASE WHEN json_valid(d.data) THEN json_extract(d.data, '$.state') END = 'open'`,
        `SELECT 'outcome:' || e.sequence, 'outcome', CAST(e.sequence AS TEXT), e.type, e.task_id, e.created_at, 'Recent task outcome'
         FROM events e WHERE e.type IN ('task.completed','task.stopped') AND e.created_at >= ?`
      );
    }
    const ctes = `WITH candidates(id, kind, source_id, state, source_task_id, at, detail) AS (${candidates.join(' UNION ALL ')}),
      ranked AS (SELECT *, CASE WHEN kind = 'outcome' THEN 2
        WHEN kind = 'task' OR (kind = 'run' AND state <> 'waiting')
          OR (kind = 'approval' AND state NOT IN ('awaiting-approval','unknown'))
          OR (kind = 'draft' AND detail NOT IN ('promptDraft','actionDraft')) THEN 1
        ELSE 0 END AS tier FROM candidates)`;
    const sql = `${ctes}
      SELECT c.*, root.id AS root_id, root.data AS root_data, ${v3 ? 'root.archived_at' : 'NULL'} AS root_archived_at
      FROM ranked c LEFT JOIN tasks source ON source.id = c.source_task_id
      LEFT JOIN tasks root ON root.id = ${v3 ? 'COALESCE(source.parent_task_id, source.id)' : 'source.id'}
      WHERE (? IS NULL OR c.tier > ? OR (c.tier = ? AND (c.at < ? OR (c.at = ? AND c.id > ?))))
      ORDER BY c.tier ASC, c.at DESC, c.id ASC LIMIT ?`;
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const args: unknown[] = [...(v3 ? [cutoff] : []), p.cursor?.tier ?? null, p.cursor?.tier ?? null, p.cursor?.tier ?? null,
      p.cursor?.at ?? null, p.cursor?.at ?? null, p.cursor?.id ?? null, p.limit + 1];
    const rows = this.store.db.prepare(sql).all(...args) as { id: string; kind: ActionItem['kind']; tier: 0 | 1 | 2; source_id: string; state: string; source_task_id: string | null; at: string; detail: string; root_id: string | null; root_data: string | null; root_archived_at: string | null }[];
    const tally = this.store.db.prepare(`${ctes} SELECT tier, COUNT(*) AS count FROM ranked GROUP BY tier`).all(...(v3 ? [cutoff] : [])) as { tier: 0 | 1 | 2; count: number }[];
    const counts = { needsDecision: tally.find(row => row.tier === 0)?.count ?? 0, inProgress: tally.find(row => row.tier === 1)?.count ?? 0,
      recent: tally.find(row => row.tier === 2)?.count ?? 0 };
    const selected = rows.slice(0, p.limit).map(row => {
      const root = row.root_data ? JSON.parse(row.root_data) as Task : null;
      return { id: row.id, kind: row.kind, tier: row.tier, sourceId: row.source_id, state: row.state, sourceTaskId: row.source_task_id ?? undefined,
        taskId: row.root_id, taskTitle: root?.title ?? 'Workspace', archived: Boolean(row.root_archived_at), createdAt: row.at,
        detail: row.kind === 'draft' ? 'Draft awaiting review' : clipped(this.redactor.text(row.detail), 100).content } satisfies ActionItem;
    });
    const last = selected.at(-1);
    return { items: selected, hasMore: rows.length > selected.length, nextCursor: last && rows.length > selected.length ? { tier: rows[selected.length - 1]!.tier, at: last.createdAt, id: last.id } : null, counts };
  }
  private events(p: { after: number; limit: number; taskId?: string }): EventPage {
    const metadata = this.store.schemaVersion >= 5 ? 'version, source, root_task_id' : 'NULL AS version, NULL AS source, NULL AS root_task_id';
    const rows = this.store.db.prepare(`SELECT sequence, type, task_id, data, created_at, ${metadata} FROM events WHERE sequence > ? ${p.taskId ? 'AND task_id = ?' : ''} ORDER BY sequence LIMIT ?`)
      .all(...(p.taskId ? [p.after, p.taskId, p.limit + 1] : [p.after, p.limit + 1])) as EventRow[];
    const selected: WorkspaceEvent[] = [];
    for (const row of rows.slice(0, p.limit)) {
      const event = this.mapEvent(row);
      if (bytes({ events: [...selected, event] }) > PAGE_ITEMS_BYTES) {
        if (!selected.length) throw new Error('Stored event metadata is too large to page safely.');
        break;
      }
      selected.push(event);
    }
    return { events: selected, nextAfter: rows.length > selected.length ? selected.at(-1)!.sequence : null };
  }
  private timeline(p: { taskId: string; before?: number; limit: number }): TimelinePage {
    const task = this.store.task(p.taskId);
    const includeChildren = this.store.schemaVersion >= 5 && !task.parentTaskId && task.mode === 'coordinated';
    const metadata = this.store.schemaVersion >= 5 ? 'version, source, root_task_id' : 'NULL AS version, NULL AS source, NULL AS root_task_id';
    const rows = this.store.db.prepare(`SELECT sequence, type, task_id, data, created_at, ${metadata} FROM events
      WHERE (task_id = ? ${includeChildren ? 'OR task_id IN (SELECT id FROM tasks WHERE parent_task_id = ?)' : ''})
      AND sequence < ? ORDER BY sequence DESC LIMIT ?`)
      .all(...(includeChildren ? [task.id, task.id] : [task.id]), p.before ?? Number.MAX_SAFE_INTEGER, p.limit + 1) as EventRow[];
    const selected: WorkspaceEvent[] = [];
    for (const row of rows.slice(0, p.limit)) {
      const event = this.mapEvent(row);
      if (bytes({ events: [...selected, event] }) > PAGE_ITEMS_BYTES) {
        if (!selected.length) throw new Error('Stored event metadata is too large to page safely.');
        break;
      }
      selected.push(event);
    }
    return { events: selected, nextBefore: rows.length > selected.length ? selected.at(-1)!.sequence : null };
  }
}
