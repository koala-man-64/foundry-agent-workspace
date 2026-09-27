import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ModelProfile, ProviderEvent, Task, UsageBreakdown, UsageFilters, UsageGroup, UsageRequest, UsageRequests, UsageSummary, UsageTotals } from '../../protocol/src/index';

type Row = Record<string, unknown>;
const columns: Record<string, keyof UsageRequest> = { request_id: 'requestId', task_id: 'taskId', root_task_id: 'rootTaskId', parent_task_id: 'parentTaskId', task_title: 'taskTitle', root_task_title: 'rootTaskTitle', profile_id: 'profileId', profile_name: 'profileName', api_kind: 'apiKind', reported_model: 'reportedModel', response_id: 'responseId', created_at: 'createdAt', attempted_at: 'attemptedAt', finished_at: 'finishedAt', reserved: 'reservedTokens', input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_tokens: 'cacheReadTokens', cache_creation_tokens: 'cacheCreationTokens', reasoning_tokens: 'reasoningTokens', usage_known: 'usageKnown', attribution_known: 'attributionKnown' };
function map(row: Row): UsageRequest {
  const result: Row = { ...row };
  for (const [sql, js] of Object.entries(columns)) { result[js] = row[sql]; delete result[sql]; }
  result.usageKnown = row.usage_known === 1; result.attributionKnown = row.attribution_known === 1;
  return result as unknown as UsageRequest;
}
function totals(): UsageTotals { return { requests: 0, attemptedRequests: 0, pendingRequests: 0, knownRequests: 0, unknownRequests: 0, notSentRequests: 0, input: 0, output: 0, total: 0, cacheRead: null, cacheCreation: null, reasoning: null, cacheReadKnownRequests: 0, cacheCreationKnownRequests: 0, reasoningKnownRequests: 0, reservedUnknown: 0, reservedPending: 0, reservedNotSent: 0 }; }
function add(t: UsageTotals, r: UsageRequest): void {
  t.requests++; if (r.attemptedAt) t.attemptedRequests++;
  if (r.outcome === 'pending') { t.pendingRequests++; t.reservedPending += r.reservedTokens; }
  else if (r.usageKnown) { t.knownRequests++; t.input += r.inputTokens ?? 0; t.output += r.outputTokens ?? 0; t.total += (r.inputTokens ?? 0) + (r.outputTokens ?? 0); }
  else if (r.attributionKnown && r.attemptedAt === null) { t.notSentRequests++; t.reservedNotSent += r.reservedTokens; }
  else { t.unknownRequests++; t.reservedUnknown += r.reservedTokens; }
  if (r.cacheReadTokens !== null) { t.cacheRead = (t.cacheRead ?? 0) + r.cacheReadTokens; t.cacheReadKnownRequests++; }
  if (r.cacheCreationTokens !== null) { t.cacheCreation = (t.cacheCreation ?? 0) + r.cacheCreationTokens; t.cacheCreationKnownRequests++; }
  if (r.reasoningTokens !== null) { t.reasoning = (t.reasoning ?? 0) + r.reasoningTokens; t.reasoningKnownRequests++; }
}
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 24); }
interface Page { n: number; cap?: number; }
function decode(cursor: string | undefined, signature: string): Page {
  if (!cursor) return { n: 0 };
  try { const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s: string; n: number; cap: number }; if (v.s === signature && Number.isSafeInteger(v.n) && v.n >= 0 && Number.isSafeInteger(v.cap) && v.cap >= 0) return v; } catch { /* invalid cursor */ }
  throw new Error('Invalid usage cursor.');
}
function encode(signature: string, n: number, cap: number): string { return Buffer.from(JSON.stringify({ s: signature, n, cap })).toString('base64url'); }
function model(r: UsageRequest): string { return r.reportedModel ?? (r.attributionKnown && r.deployment ? `${r.deployment} (deployment only)` : 'Legacy / unknown'); }
function modelKey(r: UsageRequest): string { return r.reportedModel ? `r:${r.reportedModel}` : r.attributionKnown && r.deployment ? `d:${r.deployment}` : 'u:'; }
function effort(r: UsageRequest): string { return r.attributionKnown ? (r.effort ?? 'default') : 'unknown'; }
function grouped(r: UsageRequest, group: UsageGroup): { key: string; label: string; filters: UsageFilters } {
  switch (group) {
    case 'conversation': return r.purpose === 'probe' ? { key: 'probe', label: 'Profile checks', filters: { purpose: 'probe' } } : { key: r.rootTaskId ?? r.taskId ?? 'legacy', label: r.rootTaskTitle ?? r.taskTitle ?? 'Legacy / unknown', filters: r.rootTaskId || r.taskId ? { taskId: (r.rootTaskId ?? r.taskId)!, includeChildren: true } : { purpose: 'legacy' } };
    case 'model': return { key: modelKey(r), label: model(r), filters: { model: modelKey(r) } };
    case 'effort': return { key: effort(r), label: effort(r), filters: { effort: effort(r) as UsageFilters['effort'] } };
    case 'modelEffort': return { key: `${modelKey(r)} / ${effort(r)}`, label: `${model(r)} / ${effort(r)}`, filters: { model: modelKey(r), effort: effort(r) as UsageFilters['effort'] } };
    case 'profile': return { key: r.profileId ?? 'unknown', label: r.profileName ?? 'Legacy / unknown', filters: r.profileId ? { profileId: r.profileId } : { purpose: 'legacy' } };
    case 'api': return { key: r.apiKind ?? 'unknown', label: r.apiKind ?? 'Legacy / unknown', filters: r.apiKind ? { apiKind: r.apiKind as UsageFilters['apiKind'] } : { purpose: 'legacy' } };
  }
}
export class UsageLedger {
  constructor(private readonly db: Database.Database, private readonly enabled: () => boolean) {}
  beginUsage(requestId: string, task: Task | undefined, profile: ModelProfile, reserved: number, purpose: 'conversation' | 'probe'): void {
    if (!this.enabled()) return;
    if (!Number.isSafeInteger(reserved) || reserved < 0) throw new Error('Invalid usage reservation.');
    const root = task?.rootTaskId && task.rootTaskId !== task.id ? this.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.rootTaskId) as { data: string } | undefined : undefined;
    const rootTitle = root ? (JSON.parse(root.data) as Task).title : task?.title;
    this.db.prepare(`INSERT INTO provider_requests(request_id,task_id,root_task_id,parent_task_id,task_title,root_task_title,role,purpose,profile_id,profile_name,api_kind,deployment,effort,attribution_known,created_at,outcome,reserved,usage_known)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,'pending',?,0)`).run(requestId, task?.id ?? null, task?.rootTaskId ?? task?.id ?? null, task?.parentTaskId ?? null, task?.title ?? null, rootTitle ?? null, task?.role ?? null, purpose, profile.id, profile.name, profile.apiKind, profile.deployment, profile.effort ?? null, new Date().toISOString(), reserved);
  }
  attemptUsage(requestId: string): void { if (this.enabled()) this.db.prepare('UPDATE provider_requests SET attempted_at = ? WHERE request_id = ? AND attempted_at IS NULL AND finished_at IS NULL').run(new Date().toISOString(), requestId); }
  finishUsage(requestId: string, detail: Extract<ProviderEvent, { type: 'usage' }> | undefined, outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted', reason?: string, metadata?: { reportedModel?: string; responseId?: string }): boolean {
    if (!this.enabled()) return false;
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE provider_requests SET finished_at=?, outcome=?, reason=?, reported_model=?, response_id=?, usage_known=?, input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_creation_tokens=?, reasoning_tokens=?
      WHERE request_id=? AND finished_at IS NULL`).run(now, outcome, reason ?? null, metadata?.reportedModel ?? null, metadata?.responseId ?? null, detail ? 1 : 0, detail?.inputTokens ?? null, detail?.outputTokens ?? null, detail?.cacheReadTokens ?? null, detail?.cacheCreationTokens ?? null, detail?.reasoningTokens ?? null, requestId).changes === 1;
  }
  hasUsage(requestId: string): boolean { return this.enabled() && !!this.db.prepare('SELECT 1 FROM provider_requests WHERE request_id=?').get(requestId); }
  recover(): void { if (this.enabled()) this.db.prepare("UPDATE provider_requests SET outcome='interrupted', finished_at=?, reason='Runtime restarted before request settled.' WHERE finished_at IS NULL").run(new Date().toISOString()); }
  private *records(filters: UsageFilters = {}, cap?: number): IterableIterator<UsageRequest> {
    if (filters.model && !/^(?:u:|[rd]:[\s\S]{1,200})$/.test(filters.model)) throw new Error('Invalid model filter.');
    if (!this.enabled()) { yield* this.legacyRecords(filters, cap); return; }
    const where = ['1=1']; const args: unknown[] = [];
    if (filters.from) { where.push('created_at >= ?'); args.push(new Date(filters.from).toISOString()); }
    if (filters.to) { where.push('created_at < ?'); args.push(new Date(filters.to).toISOString()); }
    if (cap !== undefined) { where.push('rowid <= ?'); args.push(cap); }
    if (!filters.includeDemo) where.push("(api_kind IS NULL OR api_kind != 'fake')");
    if (filters.taskId) { where.push(filters.includeChildren === false ? 'task_id = ?' : '(root_task_id = ? OR task_id = ?)'); args.push(filters.taskId); if (filters.includeChildren !== false) args.push(filters.taskId); }
    if (filters.profileId) { where.push('profile_id = ?'); args.push(filters.profileId); }
    if (filters.apiKind) { where.push('api_kind = ?'); args.push(filters.apiKind); }
    if (filters.purpose) { where.push('purpose = ?'); args.push(filters.purpose); }
    if (filters.effort) { where.push(filters.effort === 'unknown' ? 'attribution_known = 0' : filters.effort === 'default' ? 'effort IS NULL AND attribution_known = 1' : 'effort = ?'); if (filters.effort !== 'unknown' && filters.effort !== 'default') args.push(filters.effort); }
    if (filters.model) {
      const prefix = filters.model.slice(0, 2); const value = filters.model.slice(2);
      if (filters.model === 'u:') where.push('attribution_known = 0');
      else if (prefix === 'd:' && value.length > 0 && value.length <= 200) { where.push('reported_model IS NULL AND deployment = ? AND attribution_known = 1'); args.push(value); }
      else if (prefix === 'r:' && value.length > 0 && value.length <= 200) { where.push('reported_model = ?'); args.push(value); }
      else throw new Error('Invalid model filter.');
    }
    for (const row of this.db.prepare(`SELECT * FROM provider_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC, request_id DESC`).iterate(...args) as IterableIterator<Row>) yield map(row);
  }
  private *legacyRecords(filters: UsageFilters, cap?: number): IterableIterator<UsageRequest> {
    const where = ['1=1']; const args: unknown[] = [];
    if (filters.from) { where.push('created_at >= ?'); args.push(new Date(filters.from).toISOString()); }
    if (filters.to) { where.push('created_at < ?'); args.push(new Date(filters.to).toISOString()); }
    if (cap !== undefined) { where.push('rowid <= ?'); args.push(cap); }
    if (filters.purpose && filters.purpose !== 'legacy') return;
    if (filters.profileId || filters.apiKind || (filters.model && filters.model !== 'u:') || (filters.effort && filters.effort !== 'unknown')) return;
    if (filters.taskId && filters.includeChildren === false) { where.push('task_id=?'); args.push(filters.taskId); }
    const rows = this.db.prepare(`SELECT * FROM usage_records WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC`).iterate(...args) as IterableIterator<Row>;
    for (const row of rows) {
      const taskRow = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(row.task_id) as { data: string } | undefined;
      const task = taskRow ? JSON.parse(taskRow.data) as Task : undefined;
      const rootId = task?.rootTaskId ?? task?.id ?? null;
      if (filters.taskId && filters.includeChildren !== false && filters.taskId !== row.task_id && filters.taskId !== rootId) continue;
      const rootRow = rootId && rootId !== task?.id ? this.db.prepare('SELECT data FROM tasks WHERE id=?').get(rootId) as { data: string } | undefined : undefined;
      const rootTitle = rootRow ? (JSON.parse(rootRow.data) as Task).title : task?.title;
      yield {
        requestId: String(row.request_id), taskId: String(row.task_id), rootTaskId: rootId, parentTaskId: task?.parentTaskId ?? null,
        taskTitle: task?.title ?? null, rootTaskTitle: rootTitle ?? null, role: task?.role ?? null, purpose: 'legacy',
        profileId: null, profileName: null, apiKind: null, deployment: null, effort: null, attributionKnown: false,
        reportedModel: null, responseId: null, createdAt: String(row.created_at), attemptedAt: String(row.created_at),
        finishedAt: String(row.created_at), outcome: 'unknown', reservedTokens: Number(row.reserved),
        inputTokens: row.prompt_tokens as number | null, outputTokens: row.completion_tokens as number | null,
        cacheReadTokens: row.cache_read_tokens as number | null, cacheCreationTokens: row.cache_creation_tokens as number | null,
        reasoningTokens: null, usageKnown: row.usage_known === 1, reason: row.reason as string | null
      };
    }
  }
  private watermark(): number { return (this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${this.enabled() ? 'provider_requests' : 'usage_records'}`).get() as { n: number }).n; }
  private revision(): number { return this.enabled() ? (this.db.prepare('SELECT COUNT(*) AS n FROM provider_requests WHERE finished_at IS NOT NULL').get() as { n: number }).n : this.watermark(); }
  summary(params: { filters?: UsageFilters; timeZone?: string }): UsageSummary {
    const all = totals(); const days = new Map<string, UsageTotals>(); let daysTruncated = false;
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: params.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    for (const r of this.records(params.filters)) {
      add(all, r);
      const parts = Object.fromEntries(format.formatToParts(new Date(r.createdAt)).map(part => [part.type, part.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      if (days.has(day) || days.size < 730) { const t = days.get(day) ?? totals(); add(t, r); days.set(day, t); }
      else daysTruncated = true;
    }
    return { totals: all, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, dayTotals]) => ({ date, totals: dayTotals })), detailedTracking: this.enabled(), daysTruncated } as UsageSummary;
  }
  breakdown(params: { filters?: UsageFilters; groupBy: UsageGroup; sort?: 'tokens' | 'requests' | 'name'; cursor?: string; limit?: number }): UsageBreakdown {
    const groups = new Map<string, { key: string; label: string; totals: UsageTotals; filters: UsageFilters }>();
    const sig = fingerprint([params.filters, params.groupBy, params.sort, this.revision()]); const page = decode(params.cursor, sig);
    const cap = page.cap ?? this.watermark();
    for (const r of this.records(params.filters, cap)) { const g = grouped(r, params.groupBy); const item = groups.get(g.key) ?? { ...g, totals: totals() }; add(item.totals, r); groups.set(g.key, item); }
    const rows = [...groups.values()]; const total = rows.reduce((n, row) => n + row.totals.total, 0);
    // Largest remainder at one decimal place; every displayed share sums to 100.0.
    const exact = rows.map(r => total ? r.totals.total * 1000 / total : 0); const units = exact.map(Math.floor);
    const remainder = total ? 1000 - units.reduce((a, b) => a + b, 0) : 0;
    exact.map((v, i) => ({ i, fraction: v - units[i]! })).sort((a, b) => b.fraction - a.fraction || rows[a.i]!.key.localeCompare(rows[b.i]!.key)).slice(0, remainder).forEach(({ i }) => units[i]!++);
    const result = rows.map((r, i) => ({ ...r, sharePercent: units[i]! / 10 }));
    result.sort((a, b) => params.sort === 'name' ? a.label.localeCompare(b.label) : params.sort === 'requests' ? b.totals.requests - a.totals.requests || a.key.localeCompare(b.key) : b.totals.total - a.totals.total || a.key.localeCompare(b.key));
    const start = page.n; const limit = Math.min(params.limit ?? 50, 100);
    return { rows: result.slice(start, start + limit), nextCursor: start + limit < result.length ? encode(sig, start + limit, cap) : null };
  }
  requests(params: { filters?: UsageFilters; cursor?: string; limit?: number }): UsageRequests {
    const sig = fingerprint([params.filters, this.revision()]); const page = decode(params.cursor, sig); const limit = Math.min(params.limit ?? 50, 100); const cap = page.cap ?? this.watermark();
    const records: UsageRequest[] = []; let index = 0; let more = false;
    for (const row of this.records(params.filters, cap)) { if (index >= page.n && records.length < limit) records.push(row); else if (records.length >= limit) { more = true; break; } index++; }
    return { records, nextCursor: more ? encode(sig, page.n + records.length, cap) : null };
  }
}
