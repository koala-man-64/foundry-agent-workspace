import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile, Task } from '../../protocol/src/index';
import { Store } from '../src/store';
import { V1_SCHEMA } from '../src/schema';

let dir: string; const stores: Store[] = [];
const open = (name: string, options?: ConstructorParameters<typeof Store>[1]) => { const s = new Store(join(dir, name), options); stores.push(s); return s; };
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'foundry-usage-')); });
afterEach(async () => { vi.useRealTimers(); for (const s of stores.splice(0)) try { s.close(); } catch { /* closed */ } await rm(dir, { recursive: true, force: true }); });
const profile = (id = randomUUID()): ModelProfile => ({ id, name: 'Original', apiKind: 'responses', endpoint: 'https://example.invalid', deployment: 'configured', effort: 'medium', contextLimit: 100000, outputLimit: 4000 });
const task = (id = randomUUID(), rootTaskId?: string): Task => ({ id, title: 'Original task', projectPath: 'fixture', worktreePath: 'fixture', branch: 'codex/test', baseCommit: 'a'.repeat(40), profileId: randomUUID(), status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tokenBudget: 100000, usedTokens: 0, rootTaskId, parentTaskId: rootTaskId });

describe('canonical usage ledger', () => {
  it('snapshots attribution, distinguishes admission and attempt, and settles once with subset metrics', () => {
    const s = open('fresh.db'); const p = profile(); const t = task(); s.saveTask(t); const id = randomUUID();
    s.transaction(() => s.beginUsage(id, t, p, 900, 'conversation'));
    expect(s.usageSummary({}).totals.requests).toBe(1);
    expect(s.usageSummary({}).totals.attemptedRequests).toBe(0);
    s.attemptUsage(id);
    expect(s.finishUsage(id, { type: 'usage', inputTokens: 100, outputTokens: 30, cacheReadTokens: 80, reasoningTokens: 10 }, 'failed', 'provider failure', { reportedModel: 'actual' })).toBe(true);
    expect(s.finishUsage(id, undefined, 'completed')).toBe(false);
    const r = s.usageRequests({ filters: { includeDemo: true } }).records[0]!;
    expect(r).toMatchObject({ profileName: 'Original', deployment: 'configured', effort: 'medium', reportedModel: 'actual', outcome: 'failed', usageKnown: true });
    expect(s.usageSummary({}).totals).toMatchObject({ input: 100, output: 30, total: 130, cacheRead: 80, cacheCreation: null, reasoning: 10, reservedUnknown: 0 });
    expect(s.usageBreakdown({ groupBy: 'model' }).rows[0]).toMatchObject({ key: 'r:actual', label: 'actual', sharePercent: 100 });
  });
  it('counts coordinated children once, filters probes and demo, and binds cursors to filters', () => {
    const s = open('fresh.db'); const p = profile(); const root = task(); const child = { ...task(randomUUID(), root.id), title: 'Child task' }; s.saveTask(root); s.saveTask(child);
    for (const t of [root, child]) { const id = randomUUID(); s.beginUsage(id, t, p, 10, 'conversation'); s.attemptUsage(id); s.finishUsage(id, { type: 'usage', inputTokens: 5, outputTokens: 5 }, 'completed'); }
    const probe = randomUUID(); s.beginUsage(probe, undefined, p, 20, 'probe'); s.attemptUsage(probe); s.finishUsage(probe, undefined, 'failed');
    const demo = randomUUID(); s.beginUsage(demo, root, { ...p, apiKind: 'fake' }, 10, 'conversation'); s.finishUsage(demo, undefined, 'cancelled');
    expect(s.usageSummary({ filters: { taskId: root.id } }).totals.requests).toBe(2);
    expect(s.usageSummary({ filters: { taskId: root.id, includeChildren: false } }).totals.requests).toBe(1);
    expect(s.usageSummary({}).totals).toMatchObject({ requests: 3, total: 20, reservedUnknown: 20 });
    expect(s.usageBreakdown({ groupBy: 'conversation' }).rows.map(r => r.label)).toContain('Profile checks');
    expect(s.usageBreakdown({ groupBy: 'conversation', filters: { purpose: 'conversation' } }).rows[0]?.label).toBe('Original task');
    const first = s.usageRequests({ limit: 1 }); expect(first.nextCursor).toBeTruthy();
    expect(() => s.usageRequests({ cursor: first.nextCursor!, filters: { includeDemo: true } })).toThrow('Invalid usage cursor');
    expect(s.usageRequests({ cursor: first.nextCursor!, limit: 1 }).records).toHaveLength(1);
  });
  it('recovers original pending identities without replay or duplicate records', () => {
    const s = open('state.db'); const p = profile(); const t = task(); s.saveTask(t); const id = randomUUID(); s.beginUsage(id, t, p, 500, 'conversation'); s.attemptUsage(id); s.close(); stores.splice(stores.indexOf(s), 1);
    const restarted = open('state.db'); const r = restarted.usageRequests({}).records[0]!;
    expect(r).toMatchObject({ requestId: id, outcome: 'interrupted', reservedTokens: 500, usageKnown: false });
    expect(restarted.usageSummary({}).totals).toMatchObject({ requests: 1, reservedUnknown: 500 });
    expect(restarted.finishUsage(id, undefined, 'completed')).toBe(false);
  });
  it('separates never-dispatched cancellations and restart from possibly consumed unknown usage', () => {
    const s = open('not-sent.db'); const p = profile(); const t = task(); s.saveTask(t);
    const cancelled = randomUUID(); s.beginUsage(cancelled, t, p, 100, 'conversation'); s.finishUsage(cancelled, undefined, 'cancelled');
    const attempted = randomUUID(); s.beginUsage(attempted, t, p, 200, 'conversation'); s.attemptUsage(attempted); s.finishUsage(attempted, undefined, 'failed');
    const restarted = randomUUID(); s.beginUsage(restarted, t, p, 300, 'conversation');
    expect(s.usageSummary({}).totals).toMatchObject({ requests: 3, notSentRequests: 1, reservedNotSent: 100, unknownRequests: 1, reservedUnknown: 200, pendingRequests: 1, reservedPending: 300, total: 0 });
    s.close(); stores.splice(stores.indexOf(s), 1);
    const reopened = open('not-sent.db');
    expect(reopened.usageSummary({}).totals).toMatchObject({ requests: 3, notSentRequests: 2, reservedNotSent: 400, unknownRequests: 1, reservedUnknown: 200, pendingRequests: 0, total: 0 });
    expect(reopened.usageTotals(t.id).reservedUnknown).toBe(600);
  });
  it('accepts 200-character model drilldowns and rejects malformed unknown attribution keys', () => {
    const s = open('models.db'); const p = profile(); const t = task(); s.saveTask(t);
    const deployment = 'd'.repeat(200); const reported = 'r'.repeat(200);
    const configuredId = randomUUID(); s.beginUsage(configuredId, t, { ...p, deployment }, 1, 'conversation'); s.attemptUsage(configuredId); s.finishUsage(configuredId, { type: 'usage', inputTokens: 1, outputTokens: 0 }, 'completed');
    const reportedId = randomUUID(); s.beginUsage(reportedId, t, p, 1, 'conversation'); s.attemptUsage(reportedId); s.finishUsage(reportedId, { type: 'usage', inputTokens: 1, outputTokens: 0 }, 'completed', undefined, { reportedModel: reported });
    const rows = s.usageBreakdown({ groupBy: 'model' }).rows; expect(rows.map(r => r.key)).toEqual([`d:${deployment}`, `r:${reported}`]);
    expect(s.usageRequests({ filters: { model: `d:${deployment}` } }).records.map(r => r.requestId)).toEqual([configuredId]);
    expect(s.usageRequests({ filters: { model: `r:${reported}` } }).records.map(r => r.requestId)).toEqual([reportedId]);
    expect(() => s.usageRequests({ filters: { model: 'u:garbage' } })).toThrow('Invalid model filter');
  });
  it('upgrades v2 with verified backup while preserving original immutable history and exact totals', async () => {
    const path = join(dir, 'old.db');
    // Construct a v2 fixture by downgrading a fresh empty v3 database after dropping the new table.
    const seed = open('old.db'); seed.close(); stores.splice(stores.indexOf(seed), 1);
    const fixture = new Database(path); fixture.exec('DROP TRIGGER provider_requests_no_delete; DROP TRIGGER provider_requests_terminal; DROP TRIGGER provider_requests_identity; DROP TABLE provider_requests'); fixture.pragma('user_version = 2'); fixture.close();
    const legacy = open('old.db'); const t = task(); legacy.saveTask(t); const id = randomUUID();
    legacy.saveUsageRecord({ id: randomUUID(), taskId: t.id, requestId: id, reservedTokens: 300, promptTokens: 100, completionTokens: 20, cacheReadTokens: null, cacheCreationTokens: null, usageKnown: true, reason: null, createdAt: new Date().toISOString() });
    const upgraded = await legacy.upgradeToCurrent(); expect(upgraded.version).toBe(3);
    expect(legacy.usageSummary({}).totals).toMatchObject({ requests: 1, input: 100, output: 20, total: 120 });
    expect(legacy.usageRequests({}).records[0]).toMatchObject({ requestId: id, outcome: 'unknown', attributionKnown: false, profileId: null });
    expect((legacy.db.prepare('SELECT COUNT(*) AS n FROM usage_records').get() as { n: number }).n).toBe(1);
    const backup = new Database(upgraded.backupPath, { readonly: true }); expect(backup.pragma('user_version', { simple: true })).toBe(2); backup.close();
  });
  it('keeps v2 untouched after failed v3 backup or migration', async () => {
    const original = open('older.db'); original.close(); stores.splice(stores.indexOf(original), 1);
    const path = join(dir, 'older.db'); const db = new Database(path);
    db.exec('DROP TRIGGER provider_requests_no_delete; DROP TRIGGER provider_requests_terminal; DROP TRIGGER provider_requests_identity; DROP TABLE provider_requests'); db.pragma('user_version = 2'); db.close();
    for (const options of [{ backupFault: 'verify' as const }, { migrationFault: 'after-ddl' as const }]) {
      const s = open('older.db', options); await expect(s.upgradeToCurrent()).rejects.toThrow();
      expect(s.schemaVersion).toBe(2); expect(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='provider_requests'").get()).toBeUndefined();
      s.close(); stores.splice(stores.indexOf(s), 1);
    }
  });
  it('upgrades a v1 database directly to v3 after backing it up', async () => {
    const path = join(dir, 'v1.db'); const raw = new Database(path); raw.exec(V1_SCHEMA); raw.pragma('user_version = 1'); raw.close();
    const s = open('v1.db'); expect(s.schemaVersion).toBe(1); const t = task(); s.saveTask(t);
    const result = await s.upgradeToCurrent(); expect(result.version).toBe(3); expect(s.orchestrationAvailable).toBe(true);
    expect(s.task(t.id).title).toBe(t.title);
    const backup = new Database(result.backupPath, { readonly: true }); expect(backup.pragma('user_version', { simple: true })).toBe(1); backup.close();
  });
  it('reads existing v2 usage without changing schema or treating unavailable attribution as zero', () => {
    const fresh = open('legacy-read.db'); fresh.close(); stores.splice(stores.indexOf(fresh), 1);
    const path = join(dir, 'legacy-read.db'); const raw = new Database(path);
    raw.exec('DROP TRIGGER provider_requests_no_delete; DROP TRIGGER provider_requests_terminal; DROP TRIGGER provider_requests_identity; DROP TABLE provider_requests'); raw.pragma('user_version = 2'); raw.close();
    const s = open('legacy-read.db'); const t = task(); s.saveTask(t); const id = randomUUID();
    s.saveUsageRecord({ id: randomUUID(), taskId: t.id, requestId: id, reservedTokens: 50, promptTokens: 20, completionTokens: 10, cacheReadTokens: null, cacheCreationTokens: null, usageKnown: true, reason: null, createdAt: new Date().toISOString() });
    expect(s.hasUsage(id)).toBe(true);
    expect(s.usageSummary({}).detailedTracking).toBe(false);
    expect(s.usageSummary({}).totals).toMatchObject({ requests: 1, total: 30, cacheRead: null, reservedUnknown: 0 });
    expect(s.usageBreakdown({ groupBy: 'model' }).rows[0]).toMatchObject({ key: 'u:', label: 'Legacy / unknown' });
    expect(s.usageRequests({}).records[0]).toMatchObject({ requestId: id, attributionKnown: false, outcome: 'unknown' });
  });
  it('uses local calendar days across DST and distributes model shares to exactly 100.0', () => {
    vi.useFakeTimers(); const s = open('days.db'); const p = profile(); const t = task(); s.saveTask(t);
    const cases = [
      ['2026-03-08T05:30:00.000Z', 1], // 23:30 Chicago, prior day
      ['2026-03-08T08:30:00.000Z', 2], // 03:30 Chicago after spring transition
      ['2026-03-09T04:30:00.000Z', 3]  // 23:30 Chicago, same local day
    ] as const;
    for (const [at, amount] of cases) { vi.setSystemTime(new Date(at)); const id = randomUUID(); s.beginUsage(id, t, { ...p, deployment: `model-${amount}` }, 10, 'conversation'); s.attemptUsage(id); s.finishUsage(id, { type: 'usage', inputTokens: amount, outputTokens: 0 }, 'completed'); }
    expect(s.usageSummary({ timeZone: 'America/Chicago' }).days.map(d => d.date)).toEqual(['2026-03-07', '2026-03-08']);
    const shares = s.usageBreakdown({ groupBy: 'model' }).rows.map(r => r.sharePercent);
    expect(shares.reduce((sum, n) => sum + n, 0)).toBe(100);
    expect(s.usageSummary({ filters: { from: '2026-03-08T00:00:00-06:00' } }).totals.total).toBe(5);
  });
});
