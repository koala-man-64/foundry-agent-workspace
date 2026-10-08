import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../src/store';
import { Redactor } from '../src/redaction';
import { AutomationService } from '../src/automation';
import { WindowsHookRunner } from '../src/hook-runner';
import { newFeatureAdmission } from '../src/feature-admission';
import type { HookExecutor, HookInvocation, HookExecution } from '../src/hook-runner';
import type { Schedule, ScriptRegistration } from '../../protocol/src/automation';

class FakeExecutor implements HookExecutor {
  calls: HookInvocation[] = [];
  result: HookExecution = { stdout: '[]', stderr: '', exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true };
  async execute(input: HookInvocation): Promise<HookExecution> { this.calls.push(input); return this.result; }
}

describe('automation authority and recovery', () => {
  let directory: string; let store: Store; let automation: AutomationService; let executor: FakeExecutor; let clock: Date; let redactor: Redactor;
  const open = (): AutomationService => new AutomationService(store, redactor, () => {}, { scriptDirectory: join(directory, 'scripts'), executor, now: () => clock, resolveInterpreter: async () => ({ path: process.execPath, version: process.version }) });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foundry-automation-test-'));
    store = new Store(join(directory, 'state.db'));
    executor = new FakeExecutor(); redactor = new Redactor(); clock = new Date('2026-09-27T15:00:00.000Z');
    automation = open();
  });
  afterEach(async () => { await automation.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const script = (): ScriptRegistration => ({ id: randomUUID(), name: 'Review event', language: 'javascript', source: 'process.stdout.write("[]")', triggers: ['task.completed'], projectPath: null, arguments: [], cwd: directory, inputFields: ['sequence', 'type'], timeoutMs: 30_000 });

  it('pins PowerShell BOM bytes but returns the exact reviewed source text', async () => {
    const registration = { ...script(), language: 'powershell' as const, source: "#requires -Version 5.1\nparam([string]$Label)\n[Console]::Out.Write('café 東京 😀')" };
    const revision = await automation.dispatch('automation.script.register', registration) as { id: string; sha256: string; snapshotPath: string; configSha256: string };
    const snapshot = await readFile(revision.snapshotPath);
    expect([...snapshot.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(revision.sha256).toBe(createHash('sha256').update(snapshot).digest('hex'));
    expect(revision.configSha256).not.toBe(createHash('sha256').update(JSON.stringify({ ...registration, source: undefined })).digest('hex'));
    expect((await automation.dispatch('automation.script.source', { revisionId: revision.id }) as { source: string }).source).toBe(registration.source);
  });

  it('fails closed on a legacy PowerShell snapshot and grant without the pinned UTF-8 launcher', async () => {
    const registration = { ...script(), language: 'powershell' as const, source: "[Console]::Out.Write('café 東京 😀')" };
    const revision = await automation.dispatch('automation.script.register', registration) as { id: string; sha256: string; snapshotPath: string; configSha256: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    const legacy = { ...revision, sha256: createHash('sha256').update(registration.source).digest('hex'), configSha256: createHash('sha256').update(JSON.stringify({ ...registration, source: undefined })).digest('hex') };
    await writeFile(revision.snapshotPath, registration.source);
    const scriptRow = store.db.prepare('SELECT data FROM automation_scripts WHERE id=?').get(registration.id) as { data: string };
    const stored = JSON.parse(scriptRow.data) as { registration: ScriptRegistration; revision: typeof legacy };
    store.db.prepare('UPDATE automation_scripts SET data=?,source_sha256=? WHERE id=?').run(JSON.stringify({ ...stored, revision: legacy }), legacy.sha256, registration.id);
    store.db.prepare('UPDATE automation_revisions SET data=? WHERE id=?').run(JSON.stringify(legacy), revision.id);
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(executor.calls).toHaveLength(0);
    expect(automation.view().runs[0]?.state).toBe('failed');
    expect(automation.view().scripts[0]?.grant).toBeNull();
  });

  it('does not accept a valid-looking proposal from a script that exits with an error', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    executor.result = { ...executor.result, exitCode: 7, stdout: JSON.stringify([{ kind: 'notification', title: 'must not accept', body: 'no' }]) };
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(automation.view().runs[0]?.state).toBe('failed');
    expect(automation.view().drafts).toHaveLength(0);
  });

  it('does not accept a PowerShell proposal accompanied by stderr', async () => {
    const registration = { ...script(), language: 'powershell' as const, source: "[Console]::Out.Write('[]')" };
    const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    executor.result = { ...executor.result, stderr: 'nonterminating failure', stdout: JSON.stringify([{ kind: 'notification', title: 'must not accept', body: 'no' }]) };
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(automation.view().runs[0]?.state).toBe('failed');
    expect(automation.view().drafts).toHaveLength(0);
  });

  it('never runs a script until the exact pinned revision has a grant', async () => {
    const registration = script();
    const revision = await automation.dispatch('automation.script.register', registration) as { id: string; sha256: string };
    const first = store.event('task.completed', {}, undefined);
    await automation.onEvent(first);
    expect(executor.calls).toHaveLength(0);
    expect(automation.view().runs).toHaveLength(0);
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    const second = store.event('task.completed', {}, undefined);
    await automation.onEvent(second);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.input).toEqual({ sequence: second.sequence, type: 'task.completed' });
    await automation.onEvent(second);
    expect(executor.calls).toHaveLength(1);
  });

  it('catches up committed events after a lost callback without applying rules to history before enablement', async () => {
    store.event('task.completed', {}, undefined);
    const rule = { id: randomUUID(), version: 1, name: 'Completion note', enabled: true, triggers: ['task.completed'], projectPath: null, action: 'notification', title: 'Done', body: 'Review result' } as const;
    await automation.dispatch('automation.rule.save', rule);
    await automation.catchUp();
    expect(automation.view().drafts).toHaveLength(0);
    const missed = store.event('task.completed', {}, undefined);
    automation = open(); // emulate restart without an in-process event callback
    await automation.catchUp();
    expect(automation.view().drafts).toMatchObject([{ title: 'Done', source: 'hook' }]);
    await automation.onEvent(missed);
    expect(automation.view().drafts).toHaveLength(1);
    expect(automation.view().runs).toHaveLength(1);
  });

  it('treats output as inert drafts and rejects authority fields', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    executor.result.stdout = JSON.stringify([{ kind: 'actionDraft', title: 'Review command', body: 'Consider running tests' }]);
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(automation.view().drafts).toMatchObject([{ kind: 'actionDraft', state: 'open' }]);
    expect(store.approvals('missing')).toEqual([]);
    executor.result.stdout = JSON.stringify([{ kind: 'actionDraft', title: 'Unsafe', body: 'No', approved: true }]);
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(automation.view().runs[0]?.state).toBe('failed');
    expect(automation.view().drafts).toHaveLength(1);
  });

  it('revocation prevents later runs and interrupted dispatch is unknown on restart', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    await automation.dispatch('automation.script.revoke', { revisionId: revision.id });
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(executor.calls).toHaveLength(0);
    const runId = randomUUID(); const run = { id: runId, ruleId: revision.id, ruleVersion: 1, eventSequence: 999, state: 'dispatching', createdAt: clock.toISOString(), updatedAt: clock.toISOString() };
    store.db.prepare('INSERT INTO automation_runs(id,rule_id,rule_version,event_sequence,state,data) VALUES(?,?,?,?,?,?)').run(runId, revision.id, 1, 999, 'dispatching', JSON.stringify(run));
    automation = open();
    expect(automation.view().runs.find(item => item.id === runId)?.state).toBe('unknown');
    await automation.pumpQueued();
    expect(executor.calls).toHaveLength(0);
  });

  it('coalesces app-closed schedules and deduplicates repeated DST local times', async () => {
    const schedule: Schedule = { id: randomUUID(), name: 'Check in', enabled: true, projectPath: null, taskId: null, kind: 'promptDraft', title: 'Review', body: 'Check the workspace', cadence: 'daily', localTime: '01:30', timeZone: 'America/Chicago', startAt: '2026-10-01T00:00:00.000Z', weekDay: null };
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(new Date('2026-11-01T06:30:00.000Z'))).toBe(1);
    expect(automation.tick(new Date('2026-11-01T07:30:00.000Z'))).toBe(0);
    expect(automation.view().drafts).toHaveLength(1);
    expect(automation.tick(new Date('2026-11-04T16:00:00.000Z'))).toBe(1);
    expect(automation.view().drafts).toHaveLength(2);
    expect(executor.calls).toHaveLength(0);
  });

  it('advances across a spring DST gap and never accepts caller-selected time', async () => {
    const schedule: Schedule = { id: randomUUID(), name: 'Gap', enabled: true, projectPath: null, taskId: null, kind: 'reminder', title: 'Review', body: '', cadence: 'daily', localTime: '02:30', timeZone: 'America/Chicago', startAt: '2026-01-01T00:00:00.000Z', weekDay: null };
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(new Date('2026-03-08T07:59:00.000Z'))).toBe(1); // most recent prior day is coalesced
    expect(automation.tick(new Date('2026-03-08T08:00:00.000Z'))).toBe(1); // local clock jumps to 03:00
    await expect(automation.dispatch('automation.schedule.tick', { now: '2027-01-01T00:00:00.000Z' })).rejects.toThrow();
    const occurrences = store.db.prepare('SELECT data FROM automation_schedule_occurrences ORDER BY local_key').all() as { data: string }[];
    expect(occurrences.map(row => JSON.parse(row.data) as { dueAt: string }).at(-1)?.dueAt).toBe('2026-03-08T08:00:00.000Z');
  });

  it('catches up the first fold occurrence before the repeated wall time and retains exact UTC intent', async () => {
    const schedule: Schedule = { id: randomUUID(), name: 'Fold reopen', enabled: true, projectPath: null, taskId: null, kind: 'reminder', title: 'Review', body: '', cadence: 'daily', localTime: '01:30', timeZone: 'America/Chicago', startAt: '2026-10-01T00:00:00.000Z', weekDay: null };
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(new Date('2026-11-01T07:15:00.000Z'))).toBe(1);
    expect(automation.view().drafts[0]?.occurrence).toMatchObject({ localDate: '2026-11-01', localTime: '01:30', timeZone: 'America/Chicago', dueAt: '2026-11-01T06:30:00.000Z' });
    expect(automation.tick(new Date('2026-11-01T07:30:00.000Z'))).toBe(0);
    expect(executor.calls).toHaveLength(0);
  });

  it('honors explicit calendar dates in the selected zone and retains prior timezone revisions', async () => {
    const schedule: Schedule = { id: randomUUID(), name: 'Calendar', enabled: true, projectPath: null, taskId: null, kind: 'promptDraft', title: 'Review', body: '', cadence: 'once', localTime: '09:00', timeZone: 'Pacific/Kiritimati', startDate: '2026-11-03', startAt: '2026-10-01T00:00:00.000Z', weekDay: null };
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(new Date('2026-11-02T18:59:00.000Z'))).toBe(0);
    expect(automation.tick(new Date('2026-11-02T19:00:00.000Z'))).toBe(1);
    const prior = automation.view().drafts[0]!.occurrence!;
    expect(prior.dueAt).toBe('2026-11-02T19:00:00.000Z');
    await automation.dispatch('automation.schedule.save', { ...schedule, timeZone: 'UTC' });
    expect(automation.tick(new Date('2026-11-03T09:00:00.000Z'))).toBe(1);
    const occurrences = automation.view().drafts.map(draft => draft.occurrence!);
    expect(occurrences.map(value => value.dueAt).sort()).toEqual(['2026-11-02T19:00:00.000Z', '2026-11-03T09:00:00.000Z']);
    expect(new Set(occurrences.map(value => value.revision)).size).toBe(2);
    await expect(automation.dispatch('automation.schedule.save', { ...schedule, startDate: '2026-02-30' })).rejects.toThrow();
  });

  it('does not invent a missed occurrence before the activation instant', async () => {
    const schedule: Schedule = { id: randomUUID(), name: 'New schedule', enabled: true, projectPath: null, taskId: null, kind: 'reminder', title: 'Review', body: '', cadence: 'daily', localTime: '09:00', timeZone: 'UTC', startDate: '2026-11-03', startAt: '2026-11-03T15:00:00.000Z', weekDay: null };
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(new Date('2026-11-03T16:00:00.000Z'))).toBe(0);
    expect(automation.tick(new Date('2026-11-04T09:00:00.000Z'))).toBe(1);
    await expect(automation.dispatch('automation.schedule.save', { ...schedule, id: randomUUID(), cadence: 'once' })).rejects.toThrow('at or after its activation instant');
  });

  it('rejects expired grants and changed pinned source before process launch', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string; snapshotPath: string };
    await expect(automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-27T14:00:00.000Z', maxRunsPer24h: 100 })).rejects.toThrow('expire');
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    await writeFile(revision.snapshotPath, 'process.stdout.write("changed")');
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(executor.calls).toHaveLength(0);
    expect(automation.view().runs[0]?.state).toBe('failed');
    expect(automation.view().scripts[0]?.grant).toBeNull();
  });

  it('rejects changed interpreter bytes and exposes reviewed source only through the explicit read', async () => {
    const interpreter = join(directory, 'interpreter.exe'); await writeFile(interpreter, 'version-one');
    automation = new AutomationService(store, redactor, () => {}, { scriptDirectory: join(directory, 'scripts'), executor, now: () => clock, resolveInterpreter: async () => ({ path: interpreter, version: 'test' }) });
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string; sha256: string };
    expect(JSON.stringify(automation.view())).not.toContain(registration.source);
    const reviewed = await automation.dispatch('automation.script.source', { revisionId: revision.id }) as { source: string; revision: { sha256: string } };
    expect(reviewed.source).toBe(registration.source); expect(reviewed.revision.sha256).toBe(revision.sha256);
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    await writeFile(interpreter, 'version-two');
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(executor.calls).toHaveLength(0);
    expect(automation.view().scripts[0]?.grant).toBeNull();
  });

  it('revokes a running grant, requests cancellation, and retains uncertain effects', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let cancelled = false;
    const pending = new FakeExecutor();
    pending.execute = async input => { started(); return new Promise<HookExecution>(resolve => { input.signal.addEventListener('abort', () => { cancelled = true; resolve({ stdout: '', stderr: '', exitCode: null, cancelled: true, timedOut: false, cleanupVerified: true }); }, { once: true }); }); };
    automation = new AutomationService(store, redactor, () => {}, { scriptDirectory: join(directory, 'scripts'), executor: pending, now: () => clock, resolveInterpreter: async () => ({ path: process.execPath, version: process.version }) });
    const dispatch = automation.onEvent(store.event('task.completed', {}, undefined));
    await entered;
    await automation.dispatch('automation.script.revoke', { revisionId: revision.id });
    await dispatch;
    expect(cancelled).toBe(true);
    expect(automation.view().runs[0]?.state).toBe('unknown');
    expect(automation.view().drafts).toHaveLength(0);
  });

  it('resumes only queued runs and never replays dispatching runs after restart', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    const event = store.event('task.completed', {}, undefined);
    const queued = { id: randomUUID(), ruleId: revision.id, ruleVersion: 1, eventSequence: event.sequence, state: 'queued', createdAt: clock.toISOString(), updatedAt: clock.toISOString() };
    const unknown = { ...queued, id: randomUUID(), eventSequence: event.sequence + 1, state: 'running' };
    const save = store.db.prepare('INSERT INTO automation_runs(id,rule_id,rule_version,event_sequence,state,data) VALUES(?,?,?,?,?,?)');
    save.run(queued.id, queued.ruleId, queued.ruleVersion, queued.eventSequence, queued.state, JSON.stringify(queued));
    save.run(unknown.id, unknown.ruleId, unknown.ruleVersion, unknown.eventSequence, unknown.state, JSON.stringify(unknown));
    automation = open();
    expect(automation.view().runs.find(run => run.id === unknown.id)?.state).toBe('unknown');
    await automation.pumpQueued();
    expect(executor.calls).toHaveLength(1);
    expect(automation.view().runs.find(run => run.id === queued.id)?.state).toBe('complete');
    await automation.pumpQueued();
    expect(executor.calls).toHaveLength(1);
  });

  it('rejects oversized, malformed, and authority-bearing hook output without a draft', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    redactor.add('known-private-canary');
    for (const output of ['not-json', 'x'.repeat(64 * 1024 + 1), JSON.stringify([{ kind: 'actionDraft', title: 'x', body: 'y', nonce: 'forged' }]), JSON.stringify([{ kind: 'notification', title: 'x', body: 'known-private-canary' }])]) {
      executor.result.stdout = output;
      await automation.onEvent(store.event('task.completed', {}, undefined));
      expect(automation.view().runs[0]?.state).toBe('failed');
    }
    expect(automation.view().drafts).toHaveLength(0);
  });

  it('paginates retained drafts and coalesces weekly missed runs', async () => {
    const schedule: Schedule = { id: randomUUID(), name: 'Weekly', enabled: true, projectPath: null, taskId: null, kind: 'reminder', title: 'Review', body: 'Weekly check', cadence: 'weekly', localTime: '09:00', timeZone: 'America/Chicago', startAt: '2026-01-01T00:00:00.000Z', weekDay: 0 };
    await automation.dispatch('automation.schedule.save', schedule);
    for (let week = 0; week < 25; week++) expect(automation.tick(new Date(Date.parse('2026-02-01T16:00:00.000Z') + week * 7 * 86_400_000))).toBe(1);
    const initial = automation.view();
    expect(initial.drafts).toHaveLength(20); expect(initial.truncated).toBe(true);
    const first = await automation.dispatch('automation.query', { kind: 'drafts', limit: 20 }) as { items: unknown[]; nextCursor: number | null };
    const second = await automation.dispatch('automation.query', { kind: 'drafts', limit: 20, before: first.nextCursor }) as { items: unknown[]; nextCursor: number | null };
    expect(first.items).toHaveLength(20); expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull();
    expect(executor.calls).toHaveLength(0);
  });

  it('keeps list and query responses byte bounded while every retained draft remains pageable', async () => {
    for (let index = 0; index < 30; index++) {
      const draft = { id: randomUUID(), source: 'hook', sourceId: `large:${index}`, taskId: null, kind: 'notification', title: 'Large', body: '\u0000'.repeat(8000), state: 'open', createdAt: clock.toISOString() };
      store.db.prepare('INSERT INTO automation_drafts(id,source,source_id,data) VALUES(?,?,?,?)').run(draft.id, draft.source, draft.sourceId, JSON.stringify(draft));
    }
    const view = automation.view();
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(224 * 1024);
    expect(view.truncated).toBe(true);
    let before: number | undefined; let total = 0;
    do {
      const page = await automation.dispatch('automation.query', { kind: 'drafts', limit: 20, before }) as { items: unknown[]; nextCursor: number | null };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(224 * 1024);
      expect(page.items.length).toBeGreaterThan(0);
      total += page.items.length;
      before = page.nextCursor ?? undefined;
      if (page.nextCursor === null) break;
    } while (total < 50);
    expect(total).toBe(30);
  });

  it('commits all script proposals and the terminal run together', async () => {
    const revision = await automation.dispatch('automation.script.register', script()) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    executor.result.stdout = JSON.stringify([{ kind: 'notification', title: 'First', body: 'a' }, { kind: 'notification', title: 'Second', body: 'b' }]);
    store.db.exec("CREATE TRIGGER reject_second_hook_draft BEFORE INSERT ON automation_drafts WHEN NEW.source_id LIKE '%:1' BEGIN SELECT RAISE(ABORT, 'simulated write fault'); END");
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(automation.view().drafts).toHaveLength(0);
    expect(automation.view().runs[0]?.state).toBe('unknown');
  });

  it('revokes queued run JSON and discards a late clean result from a running script', async () => {
    const revision = await automation.dispatch('automation.script.register', script()) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    const queued = { id: randomUUID(), ruleId: revision.id, ruleVersion: 1, eventSequence: 999, state: 'queued', createdAt: clock.toISOString(), updatedAt: clock.toISOString() };
    store.db.prepare('INSERT INTO automation_runs(id,rule_id,rule_version,event_sequence,state,data) VALUES(?,?,?,?,?,?)').run(queued.id, queued.ruleId, queued.ruleVersion, queued.eventSequence, queued.state, JSON.stringify(queued));
    let finish!: (result: HookExecution) => void;
    executor.execute = async input => { executor.calls.push(input); return new Promise(resolve => { finish = resolve; }); };
    const pending = automation.onEvent(store.event('task.completed', {}, undefined));
    for (let attempt = 0; attempt < 50 && !finish; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(finish).toBeTypeOf('function');
    await automation.dispatch('automation.script.revoke', { revisionId: revision.id });
    finish({ stdout: JSON.stringify([{ kind: 'actionDraft', title: 'Late', body: 'No' }]), stderr: '', exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true });
    await pending;
    const row = store.db.prepare('SELECT state,data FROM automation_runs WHERE id = ?').get(queued.id) as { state: string; data: string };
    expect(row.state).toBe('cancelled'); expect(JSON.parse(row.data).state).toBe('cancelled');
    expect(automation.view().drafts).toHaveLength(0);
  });

  it('uses a new occurrence identity when a schedule is edited but not when saved unchanged', async () => {
    const schedule: Schedule = { id: randomUUID(), name: 'Today', enabled: true, projectPath: null, taskId: null, kind: 'reminder', title: 'First', body: 'Review', cadence: 'daily', localTime: '09:00', timeZone: 'America/Chicago', startAt: '2026-01-01T00:00:00.000Z', weekDay: null };
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(clock)).toBe(1);
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(clock)).toBe(0);
    await automation.dispatch('automation.schedule.save', { ...schedule, title: 'Revised' });
    expect(automation.tick(clock)).toBe(1);
    expect(automation.view().drafts).toHaveLength(2);
    await automation.dispatch('automation.schedule.remove', { scheduleId: schedule.id });
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(clock)).toBe(1);
    expect(automation.view().drafts).toHaveLength(3);
  });

  it('refuses a hook working directory on a network share before touching it (decision 8)', async () => {
    // Loopback shares, so a regression fails fast; a stat of a missing share would report a different message.
    for (const cwd of ['\\\\127.0.0.1\\foundry-unc-test', '//127.0.0.1/foundry-unc-test', '\\\\?\\UNC\\127.0.0.1\\foundry-unc-test']) {
      await expect(automation.dispatch('automation.script.register', { ...script(), cwd })).rejects.toThrow('Hook working directory must not be on a network share.');
    }
    expect(automation.view().scripts).toHaveLength(0);
  });

  it('rejects hook source above the UTF-8 byte budget even when its character count fits', async () => {
    await expect(automation.dispatch('automation.script.register', { ...script(), source: '😀'.repeat(20_000) })).rejects.toThrow('64 KiB');
    await expect(automation.dispatch('automation.script.register', { ...script(), source: '\u0000'.repeat(40_000) })).rejects.toThrow('serialized review limit');
    expect(automation.view().scripts).toHaveLength(0);
  });

  it('retains the exact grant and pin admitted at dispatch after renewal and revocation', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string; sha256: string; interpreterSha256: string; configSha256: string };
    automation = new AutomationService(store, redactor, (type, data, taskId) => { store.event(type, data, taskId); }, { scriptDirectory: join(directory, 'scripts'), executor, now: () => clock, resolveInterpreter: async () => ({ path: process.execPath, version: process.version }) });
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 25 });
    await automation.onEvent(store.event('task.completed', {}, undefined));
    const run = automation.view().runs[0]!;
    expect(run.state).toBe('complete');
    expect(run.grantSnapshot).toMatchObject({ revisionId: revision.id, maxRunsPer24h: 25 });
    expect(run.pin).toEqual({ revisionId: revision.id, scriptId: registration.id, sourceSha256: revision.sha256, interpreterSha256: revision.interpreterSha256, configSha256: revision.configSha256 });
    const firstId = run.grantSnapshot!.id;
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-29T15:00:00.000Z', maxRunsPer24h: 10 });
    await automation.dispatch('automation.script.revoke', { revisionId: revision.id });
    const retained = automation.view().runs.find(item => item.id === run.id)!;
    expect(retained.grantSnapshot?.id).toBe(firstId);
    expect(retained.grantSnapshot?.maxRunsPer24h).toBe(25);
    const history = store.db.prepare('SELECT action,grant_id,reason FROM automation_grant_history WHERE revision_id = ? ORDER BY rowid').all(revision.id) as { action: string; grant_id: string; reason: string | null }[];
    expect(history.map(item => item.action)).toEqual(['issued', 'revoked', 'issued', 'revoked']);
    expect(history[0]?.grant_id).toBe(firstId); expect(history[1]?.grant_id).toBe(firstId);
    expect(history[2]?.grant_id).not.toBe(firstId); expect(history[3]?.grant_id).toBe(history[2]?.grant_id);
    const events = store.db.prepare("SELECT type FROM events WHERE type LIKE 'automation.grant.%' ORDER BY sequence").all() as { type: string }[];
    expect(events.map(item => item.type)).toEqual(['automation.grant.issued', 'automation.grant.revoked', 'automation.grant.issued', 'automation.grant.revoked']);
  });

  it('does not accept output under a replacement grant while an older grant is in flight', async () => {
    const revision = await automation.dispatch('automation.script.register', script()) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 25 });
    let finish!: (result: HookExecution) => void;
    executor.execute = async input => { executor.calls.push(input); return new Promise(resolve => { finish = resolve; }); };
    const pending = automation.onEvent(store.event('task.completed', {}, undefined));
    for (let attempt = 0; attempt < 50 && !finish; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(finish).toBeTypeOf('function');
    const firstId = automation.view().runs[0]?.grantSnapshot?.id;
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-29T15:00:00.000Z', maxRunsPer24h: 10 });
    finish({ stdout: JSON.stringify([{ kind: 'notification', title: 'Late', body: 'No' }]), stderr: '', exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true });
    await pending;
    expect(automation.view().runs[0]).toMatchObject({ state: 'unknown', grantSnapshot: { id: firstId, maxRunsPer24h: 25 } });
    expect(automation.view().drafts).toHaveLength(0);
  });

  it('cancels a queued old-grant run on renewal and admits only a future event', async () => {
    const revision = await automation.dispatch('automation.script.register', script()) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 25 });
    const oldEvent = store.event('task.completed', {}, undefined);
    const queued = { id: randomUUID(), ruleId: revision.id, ruleVersion: 1, eventSequence: oldEvent.sequence, state: 'queued', createdAt: clock.toISOString(), updatedAt: clock.toISOString() };
    store.db.prepare('INSERT INTO automation_runs(id,rule_id,rule_version,event_sequence,state,data) VALUES(?,?,?,?,?,?)').run(queued.id, queued.ruleId, queued.ruleVersion, queued.eventSequence, queued.state, JSON.stringify(queued));
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-29T15:00:00.000Z', maxRunsPer24h: 10 });
    const cancelled = store.db.prepare('SELECT state,data FROM automation_runs WHERE id = ?').get(queued.id) as { state: string; data: string };
    expect(cancelled.state).toBe('cancelled'); expect(JSON.parse(cancelled.data).state).toBe('cancelled');
    await automation.pumpQueued();
    expect(executor.calls).toHaveLength(0);
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(executor.calls).toHaveLength(1);
    expect(automation.view().runs.find(run => run.id === queued.id)?.state).toBe('cancelled');
  });

  it('previews filtered rules without effects and prepares one fresh review for a typed action draft', async () => {
    const taskId = randomUUID();
    store.saveTask({ id: taskId, title: 'Coding fixture', projectPath: directory, worktreePath: directory, branch: 'fixture', baseCommit: '0'.repeat(40), profileId: randomUUID(), status: 'idle', createdAt: clock.toISOString(), updatedAt: clock.toISOString(), tokenBudget: 10000, usedTokens: 0, mode: 'coding' });
    let calls = 0;
    automation = new AutomationService(store, redactor, () => {}, { scriptDirectory: join(directory, 'scripts'), executor, now: () => clock, resolveInterpreter: async () => ({ path: process.execPath, version: process.version }), prepareAction: async draft => {
      calls++; expect(draft.proposal?.tool).toBe('run_command');
      const approvalId = randomUUID();
      store.saveApproval({ id: approvalId, taskId, toolCallId: randomUUID(), nonce: randomUUID(), tool: 'run_command', state: 'awaiting-approval', createdAt: clock.toISOString(), summary: 'review', fingerprint: randomUUID(), origin: 'hook' });
      return { approvalId };
    } });
    const rule = { id: randomUUID(), version: 1, name: 'Review command', enabled: true, triggers: ['task.completed'], projectPath: directory, taskId, conditions: { status: 'idle', mode: 'coding' }, action: 'actionDraft', title: 'Review tests', body: 'Run the focused checks', proposal: { tool: 'run_command', arguments: { command: 'Write-Output ok', cwd: '', environment: {}, timeoutMs: 1000 } } } as const;
    await automation.dispatch('automation.rule.save', rule);
    const before = automation.view();
    const preview = await automation.dispatch('automation.rule.preview', { ruleId: rule.id, taskId, eventType: 'task.completed' }) as { matches: boolean; draftPreview: unknown };
    expect(preview.matches).toBe(true); expect(preview.draftPreview).toMatchObject({ kind: 'actionDraft', title: rule.title });
    expect(automation.view().drafts).toEqual(before.drafts);
    expect(automation.view().runs).toEqual(before.runs);
    await automation.onEvent(store.event('task.completed', {}, taskId));
    const draft = automation.view().drafts[0]!;
    expect(draft.proposal?.tool).toBe('run_command');
    const prepared = await automation.dispatch('automation.draft.prepare', { draftId: draft.id }) as { approvalId: string };
    expect(prepared.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toBe(1);
    await expect(automation.dispatch('automation.draft.prepare', { draftId: draft.id })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(automation.view().drafts[0]).toMatchObject({ state: 'awaiting-approval', approvalId: prepared.approvalId });
  });

  it('rejects authority fields, invalid tool arguments, and hook-provided command environment', async () => {
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    for (const proposal of [
      { tool: 'run_command', arguments: { command: 'Write-Output hi', cwd: '', environment: { FOO: 'bar' } } },
      { tool: 'write_file', arguments: { path: 'README.md', expectedHash: 'stale', content: 'x' } },
      { tool: 'run_command', arguments: { command: 'Write-Output hi' }, approved: true }
    ]) {
      executor.result.stdout = JSON.stringify([{ kind: 'actionDraft', title: 'Unsafe', body: 'No', proposal }]);
      await automation.onEvent(store.event('task.completed', {}, undefined));
      expect(automation.view().runs[0]?.state).toBe('failed');
    }
    expect(automation.view().drafts).toHaveLength(0);
  });

  it('pauses hook dispatch and schedules durably without removing retained rules, grants, or drafts', async () => {
    const admission = newFeatureAdmission(store);
    const registration = script(); const revision = await automation.dispatch('automation.script.register', registration) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 });
    const schedule: Schedule = { id: randomUUID(), name: 'Review', enabled: true, projectPath: null, taskId: null, kind: 'reminder', title: 'Review', body: '', cadence: 'once', localTime: '00:00', timeZone: 'UTC', startAt: '2020-01-01T00:00:00.000Z', weekDay: null };
    await automation.dispatch('automation.schedule.save', schedule);
    const queued = { id: randomUUID(), ruleId: revision.id, ruleVersion: 1, eventSequence: 999, state: 'queued', createdAt: clock.toISOString(), updatedAt: clock.toISOString() };
    store.db.prepare('INSERT INTO automation_runs(id,rule_id,rule_version,event_sequence,state,data) VALUES(?,?,?,?,?,?)').run(queued.id, queued.ruleId, queued.ruleVersion, queued.eventSequence, queued.state, JSON.stringify(queued));
    admission.set({ feature: 'hooks', enabled: false, reason: 'runtime-fault' }); admission.set({ feature: 'scheduling', enabled: false, reason: 'runtime-fault' });
    automation = new AutomationService(store, redactor, () => {}, { scriptDirectory: join(directory, 'scripts'), executor, now: () => clock, resolveInterpreter: async () => ({ path: process.execPath, version: process.version }), admission: () => ({ hooks: admission.get('hooks').enabled, scheduling: admission.get('scheduling').enabled }) });
    await automation.pumpQueued();
    expect(automation.view().runs.find(run => run.id === queued.id)?.state).toBe('cancelled');
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(executor.calls).toHaveLength(0);
    expect(automation.tick(clock)).toBe(0);
    expect(automation.view().scripts).toHaveLength(1);
    expect(automation.view().schedules).toHaveLength(1);
    await expect(automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-09-28T15:00:00.000Z', maxRunsPer24h: 100 })).rejects.toThrow('paused');
    await expect(automation.dispatch('automation.schedule.save', schedule)).rejects.toThrow('paused');
    await automation.dispatch('automation.schedule.save', { ...schedule, enabled: false });
    admission.set({ feature: 'hooks', enabled: true }); admission.set({ feature: 'scheduling', enabled: true });
    expect(automation.tick(clock)).toBe(0); // A saved disabled schedule stays disabled after feature reenable.
    await automation.dispatch('automation.schedule.save', schedule);
    expect(automation.tick(clock)).toBe(1);
    await automation.onEvent(store.event('task.completed', {}, undefined));
    expect(executor.calls).toHaveLength(1); // Suppressed historical event was not replayed.
  });
});

describe.runIf(process.platform === 'win32')('Windows hook Job lifecycle', () => {
  it('round-trips Unicode through a BOM-pinned PowerShell script with #requires and a named parameter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-hook-powershell-unicode-'));
    try {
      const scriptPath = join(directory, 'hook.ps1');
      await writeFile(scriptPath, `\uFEFF#requires -Version 5.1
param([string]$Label)
$event = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Console]::Out.Write((@{ kind = 'notification'; title = $Label; body = $event.body } | ConvertTo-Json -Compress))`, 'utf8');
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = await new WindowsHookRunner().execute({ command: powershell, arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Label', 'café 東京 😀'], cwd: directory, input: { body: 'café 東京 😀' }, timeoutMs: 10_000, signal: new AbortController().signal, language: 'powershell' });
      expect(result.exitCode).toBe(0); expect(result.cleanupVerified).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({ kind: 'notification', title: 'café 東京 😀', body: 'café 東京 😀' });
      const literal = "café 東京 😀'; [Console]::Out.Write('INJECTED'); ' $& $' $`";
      const quoted = await new WindowsHookRunner().execute({ command: powershell, arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Label', literal], cwd: directory, input: { body: 'café 東京 😀' }, timeoutMs: 10_000, signal: new AbortController().signal, language: 'powershell' });
      expect(JSON.parse(quoted.stdout)).toEqual({ kind: 'notification', title: literal, body: 'café 東京 😀' });
      const noArgs = await new WindowsHookRunner().execute({ command: powershell, arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], cwd: directory, input: { body: 'café 東京 😀' }, timeoutMs: 10_000, signal: new AbortController().signal, language: 'powershell' });
      expect(noArgs.exitCode).toBe(0);
      expect(JSON.parse(noArgs.stdout)).toEqual({ kind: 'notification', title: '', body: 'café 東京 😀' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('preserves a PowerShell script failure after it emits a valid-looking draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-hook-powershell-exit-'));
    try {
      const scriptPath = join(directory, 'exit.ps1');
      await writeFile(scriptPath, "\uFEFF[Console]::Out.Write('[{\"kind\":\"notification\",\"title\":\"must not accept\",\"body\":\"no\"}]'); exit 7", 'utf8');
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = await new WindowsHookRunner().execute({ command: powershell, arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], cwd: directory, input: {}, timeoutMs: 10_000, signal: new AbortController().signal, language: 'powershell' });
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain('must not accept');
      const warningPath = join(directory, 'warning.ps1');
      await writeFile(warningPath, "\uFEFFWrite-Error 'nonterminating failure'; [Console]::Out.Write('[{\"kind\":\"notification\",\"title\":\"must not accept\",\"body\":\"no\"}]')", 'utf8');
      const warning = await new WindowsHookRunner().execute({ command: powershell, arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', warningPath], cwd: directory, input: {}, timeoutMs: 10_000, signal: new AbortController().signal, language: 'powershell' });
      expect(warning.exitCode).not.toBe(0);
      expect(warning.stdout).toContain('must not accept');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('preserves multibyte stdout across pipe chunks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-hook-utf8-test-'));
    try {
      const scriptPath = join(directory, 'hook.js');
      await writeFile(scriptPath, `const value=Buffer.from('😀 café','utf8'); process.stdin.resume(); process.stdin.on('end',()=>{ process.stdout.write(value.subarray(0,2)); setTimeout(()=>process.stdout.write(value.subarray(2)),100); });`);
      const result = await new WindowsHookRunner().execute({ command: process.execPath, arguments: [scriptPath], cwd: directory, input: { sequence: 1 }, timeoutMs: 10_000, signal: new AbortController().signal, language: 'javascript' });
      expect(result.stdout).toBe('😀 café');
      expect(result.cleanupVerified).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('fails closed when the helper exits before consuming stdin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-hook-stdin-test-'));
    try {
      const hostPath = join(directory, 'early-exit.ps1');
      await writeFile(hostPath, 'exit 0');
      const runner = new WindowsHookRunner(hostPath);
      await expect(runner.execute({ command: process.execPath, arguments: ['-e', ''], cwd: directory, input: { payload: 'x'.repeat(60 * 1024) }, timeoutMs: 10_000, signal: new AbortController().signal, language: 'javascript' })).rejects.toThrow(/Hook (process pipe failed|helper did not confirm)/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('delivers bounded stdin and terminates a child process tree on cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-hook-job-test-'));
    try {
      const scriptPath = join(directory, 'hook.js'); const pidPath = join(directory, 'child.pid'); const inputPath = join(directory, 'input.json');
      await writeFile(scriptPath, `const fs=require('fs'); const cp=require('child_process'); fs.writeFileSync(${JSON.stringify(inputPath)},fs.readFileSync(0,'utf8')); const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid)); setTimeout(()=>{},120000);`);
      const controller = new AbortController();
      const executing = new WindowsHookRunner().execute({ command: process.execPath, arguments: [scriptPath], cwd: directory, input: { sequence: 1, type: 'task.completed' }, timeoutMs: 30_000, signal: controller.signal, language: 'javascript' });
      let pid = 0;
      for (let attempt = 0; attempt < 100; attempt++) { const raw = await readFile(pidPath, 'utf8').catch(() => ''); if (raw) { pid = Number(raw); break; } await new Promise(resolve => setTimeout(resolve, 100)); }
      expect(pid).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(inputPath, 'utf8'))).toEqual({ sequence: 1, type: 'task.completed' });
      controller.abort();
      const result = await executing;
      expect(result.cancelled).toBe(true); expect(result.cleanupVerified).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);
});
