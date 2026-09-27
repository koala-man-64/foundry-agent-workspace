import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { AutomationDraft, ContinuationPreview, ContinuityView, GitTask, Task, TranscriptExport } from '../../protocol/src/index';
import { Store, FAKE_PROFILE_ID } from '../src/store';
import { RepositoryService } from '../src/repository';
import { RuntimeService } from '../src/service';

let directory: string; let project: string; let store: Store; let runtime: RuntimeService; let task: GitTask; let repositories: RepositoryService;
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-continuity-')); project = join(directory, 'source'); await mkdir(project);
  git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Fixture\n'); git(project, 'add', 'README.md'); git(project, 'commit', '-m', 'fixture');
  store = new Store(join(directory, 'state', 'workspace.db')); repositories = new RepositoryService(join(directory, 'worktrees')); runtime = new RuntimeService(store, repositories, () => undefined);
  task = await runtime.dispatch('task.create', { title: 'Source', projectPath: project, profileId: FAKE_PROFILE_ID, tokenBudget: 10000, mode: 'chat' }) as GitTask;
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
const addMessage = (content: string): string => { const id = randomUUID(); store.saveMessage({ id, taskId: task.id, role: 'assistant', content, status: 'complete', createdAt: new Date().toISOString() }); return id; };

describe('continuity authority and exports', () => {
  it('copies selected evidence provenance without approval or tool payload authority', async () => {
    const recorded = store.event('validation.completed', { passed: true, head: 'a'.repeat(40), nonce: 'excluded-nonce', arguments: { credential: 'excluded-credential' }, providerState: 'excluded-native' }, task.id);
    const intentId = store.intent('tool.approval', { taskId: task.id, nonce: 'excluded-intent-nonce', arguments: { command: 'excluded-command' } });
    store.finishIntent(intentId, 'complete');
    const evidenceIds = [`event:${recorded.sequence}`, intentId];
    const preview = await runtime.dispatch('task.continuationPreview', { taskId: task.id, messageIds: [], evidenceIds }) as ContinuationPreview;
    expect(preview.evidenceIds).toEqual(evidenceIds); expect(preview.context).toContain('validation.completed'); expect(preview.context).toContain('"passed":true');
    expect(preview.context).not.toContain('excluded-'); expect(preview.context).toContain('historical metadata only');
    const fresh = await runtime.dispatch('task.continue', { previewId: preview.id, title: 'Evidence follow-up', profileId: FAKE_PROFILE_ID, tokenBudget: 12000 }) as Task;
    expect((await runtime.dispatch('continuity.get', { taskId: fresh.id }) as ContinuityView).lineage[0]!.evidenceIds).toEqual(evidenceIds);
    expect(store.approvals(fresh.id)).toEqual([]); expect(store.providerState(fresh.id)).toBeUndefined();
    await expect(runtime.dispatch('task.continuationPreview', { taskId: fresh.id, messageIds: [], evidenceIds })).rejects.toThrow('does not belong');
  });
  it('bounds preview JSON after escaping and rejects oversized selections before creating a preview', async () => {
    const escaped = addMessage('\u0000'.repeat(48 * 1024));
    await expect(runtime.dispatch('task.continuationPreview', { taskId: task.id, messageIds: [escaped] })).rejects.toThrow('serialized preview limit');
    const bounded = addMessage('\u0000'.repeat(8 * 1024));
    const preview = await runtime.dispatch('task.continuationPreview', { taskId: task.id, messageIds: [bounded] }) as ContinuationPreview;
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(256 * 1024);
    expect(preview.context).toContain('\u0000'.repeat(8 * 1024));
  });
  it('creates an independent idle continuation with redacted selected messages and an exact source commit', async () => {
    const canary = 'continuity-secret-canary-7a834'; runtime.redactor.add(canary); const messageId = addMessage(`Selected result ${canary}`);
    store.saveProviderState(task.id, { fingerprint: 'fixture', pending: [], results: [], continuation: { apiKind: 'fake', data: { opaque: 'never-export-this-provider-state' } } });
    const preview = await runtime.dispatch('task.continuationPreview', { taskId: task.id, messageIds: [messageId] }) as ContinuationPreview;
    expect(preview.context).toContain('[REDACTED]'); expect(preview.context).not.toContain(canary);
    const fresh = await runtime.dispatch('task.continue', { previewId: preview.id, title: 'Continuation', profileId: FAKE_PROFILE_ID, tokenBudget: 12000, mode: 'chat' }) as GitTask;
    expect(fresh.id).not.toBe(task.id); expect(fresh.worktreePath).not.toBe(task.worktreePath); expect(fresh.status).toBe('idle');
    expect(git(fresh.worktreePath, 'rev-parse', 'HEAD')).toBe(preview.sourceCommit);
    expect(store.providerState(fresh.id)).toBeUndefined(); expect(store.approvals(fresh.id)).toEqual([]);
    expect(store.detail(fresh.id).messages[0]!.content).toContain(messageId);
    expect((await runtime.dispatch('continuity.get', { taskId: fresh.id }) as ContinuityView).lineage[0]!.sourceTaskId).toBe(task.id);
    await expect(runtime.dispatch('task.continue', { previewId: preview.id, title: 'Replay', profileId: FAKE_PROFILE_ID, tokenBudget: 12000 })).rejects.toThrow(/expired/);
  });
  it('invalidates a continuation after source change and blocks unresolved execution', async () => {
    const messageId = addMessage('Evidence'); const preview = await runtime.dispatch('task.continuationPreview', { taskId: task.id, messageIds: [messageId] }) as ContinuationPreview;
    await writeFile(join(task.worktreePath, 'README.md'), 'changed');
    await expect(runtime.dispatch('task.continue', { previewId: preview.id, title: 'Changed', profileId: FAKE_PROFILE_ID, tokenBudget: 10000 })).rejects.toThrow(/clean|dirty/i);
    const unknown = store.intent('tool.approval', { taskId: task.id }); store.finishIntent(unknown, 'unknown');
    await expect(runtime.dispatch('task.continuationPreview', { taskId: task.id, messageIds: [messageId] })).rejects.toThrow(/unknown execution/);
  });
  it('exports a complete snapshot and checksum manifest without opaque state or executable approvals', async () => {
    const canary = 'export-secret-canary-8943'; runtime.redactor.add(canary); const messageId = addMessage(`Visible ${canary}`);
    store.saveProviderState(task.id, { fingerprint: 'fixture', pending: [], results: [], continuation: { apiKind: 'fake', data: { opaque: 'provider-secret-opaque' } } });
    const executable = 'one-shot-nonce-do-not-export'; store.intent('tool.approval', { taskId: task.id, nonce: executable, arguments: { password: canary } });
    const exported = await runtime.dispatch('task.exportTranscript', { taskId: task.id }) as TranscriptExport;
    expect(exported.messageCount).toBe(1);
    for (const file of exported.files) { const bytes = await readFile(join(exported.path, file.name)); expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256); expect(bytes.length).toBe(file.bytes); expect(bytes.toString()).not.toContain(canary); expect(bytes.toString()).not.toContain(executable); expect(bytes.toString()).not.toContain('provider-secret-opaque'); }
    const json = JSON.parse(await readFile(join(exported.path, 'transcript.json'), 'utf8')) as { version: number; tasks: { messages: { id: string; content: string }[] }[] };
    expect(json.version).toBe(1); expect(json.tasks[0]!.messages[0]!.id).toBe(messageId); expect(json.tasks[0]!.messages[0]!.content).toBe('Visible [REDACTED]');
    expect((await readdir(join(directory, 'state', 'exports'))).some(name => name.endsWith('.partial'))).toBe(false);
  });
  it('holds a consistent read snapshot when a message arrives during export', async () => {
    const original = addMessage('SNAPSHOT_BOUNDARY');
    const text = runtime.redactor.text.bind(runtime.redactor); let concurrent: string | undefined;
    const spy = vi.spyOn(runtime.redactor, 'text').mockImplementation(value => {
      if (!concurrent && value.includes('SNAPSHOT_BOUNDARY')) concurrent = addMessage('Arrived during export');
      return text(value);
    });
    let exported: TranscriptExport;
    try { exported = await runtime.dispatch('task.exportTranscript', { taskId: task.id }) as TranscriptExport; }
    finally { spy.mockRestore(); }
    expect(concurrent).toBeDefined();
    const json = JSON.parse(await readFile(join(exported.path, 'transcript.json'), 'utf8')) as { tasks: { messages: { id: string }[] }[] };
    expect(json.tasks[0]!.messages.map(message => message.id)).toEqual([original]);
    expect(store.detail(task.id).messages.map(message => message.id)).toEqual([original, concurrent]);
  });
  it('removes incomplete export output after a write interruption', async () => {
    addMessage('INTERRUPT_EXPORT');
    const text = runtime.redactor.text.bind(runtime.redactor);
    const spy = vi.spyOn(runtime.redactor, 'text').mockImplementation(value => {
      if (value.includes('INTERRUPT_EXPORT')) throw new Error('Injected export interruption');
      return text(value);
    });
    try { await expect(runtime.dispatch('task.exportTranscript', { taskId: task.id })).rejects.toThrow('Injected export interruption'); }
    finally { spy.mockRestore(); }
    expect(await readdir(join(directory, 'state', 'exports'))).toEqual([]);
    expect(store.detail(task.id).messages.at(-1)?.content).toBe('INTERRUPT_EXPORT');
  });
  it('requires real source references and preserves superseded decisions', async () => {
    const messageId = addMessage('Choose an explicit contract');
    await expect(runtime.dispatch('decision.save', { taskId: task.id, title: 'Invalid', rationale: 'Missing source', messageIds: [randomUUID()] })).rejects.toThrow(/does not belong/);
    const first = await runtime.dispatch('decision.save', { taskId: task.id, title: 'Initial', rationale: 'Recorded explicitly', messageIds: [messageId] }) as { id: string };
    await runtime.dispatch('decision.save', { taskId: task.id, title: 'Revised', rationale: 'New evidence', supersedesId: first.id, messageIds: [messageId] });
    const view = await runtime.dispatch('continuity.get', { taskId: task.id }) as ContinuityView;
    expect(view.decisions).toHaveLength(2); expect(view.decisions.find(card => card.id === first.id)!.superseded).toBe(true);
  });
  it('blocks starting source execution while a continuation is being created', async () => {
    const messageId = addMessage('Prior result'); const preview = await runtime.dispatch('task.continuationPreview', { taskId: task.id, messageIds: [messageId] }) as ContinuationPreview;
    const original = repositories.continuationSource.bind(repositories); let resume!: () => void; let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; }); const barrier = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(repositories, 'continuationSource').mockImplementationOnce(async (...args) => { entered(); await barrier; return original(...args); });
    const continuing = runtime.dispatch('task.continue', { previewId: preview.id, title: 'Locked continuation', profileId: FAKE_PROFILE_ID, tokenBudget: 10000 });
    await entry;
    try { await expect(runtime.dispatch('task.send', { taskId: task.id, content: 'Start concurrently' })).rejects.toThrow(/continuation/); }
    finally { resume(); }
    expect((await continuing as Task).status).toBe('idle'); expect(store.task(task.id).status).toBe('idle');
  });
  it('pages long decisions and templates within the response byte budget', async () => {
    for (let i = 0; i < 11; i++) {
      await runtime.dispatch('decision.save', { taskId: task.id, title: String(i), rationale: '\\'.repeat(15000) });
      await runtime.dispatch('templates.save', { id: randomUUID(), name: String(i), prompt: '\\'.repeat(15000), mode: 'chat', profileId: FAKE_PROFILE_ID, tokenBudget: 10000 });
    }
    const view = await runtime.dispatch('continuity.get', { taskId: task.id }) as ContinuityView;
    expect(view.decisions).toHaveLength(5); expect(view.nextBefore).not.toBeNull(); expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(256 * 1024);
    let after: string | undefined; const templates: string[] = [];
    do { const page = await runtime.dispatch('templates.list', { after }) as { items: { id: string }[]; nextAfter: string | null }; expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024); templates.push(...page.items.map(item => item.id)); after = page.nextAfter ?? undefined; } while (after);
    expect(new Set(templates).size).toBe(11);
  });
  it('requires fresh one-shot review for an action draft and excludes hook approvals from recursive activation', async () => {
    store.saveTask({ ...task, mode: 'coding' });
    await runtime.dispatch('automation.rule.save', { id: randomUUID(), name: 'Decision observer', version: 1, enabled: true, triggers: ['approval.changed'], projectPath: null, action: 'notification', title: 'Observed', body: '' });
    const bytes = await readFile(join(task.worktreePath, 'README.md')); const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const draft: AutomationDraft = { id: randomUUID(), source: 'hook', sourceId: randomUUID(), taskId: task.id, kind: 'actionDraft', title: 'Proposed edit', body: 'Review the exact diff', state: 'open', createdAt: new Date().toISOString(), proposal: { tool: 'write_file', arguments: { path: 'README.md', expectedHash, content: '# Explicitly reviewed\n' } } };
    store.db.prepare('INSERT INTO automation_drafts(id,source,source_id,data) VALUES(?,?,?,?)').run(draft.id, draft.source, draft.sourceId, JSON.stringify(draft));
    await runtime.dispatch('features.set', { feature: 'hooks', enabled: false });
    await expect(runtime.dispatch('automation.draft.prepare', { draftId: draft.id })).rejects.toThrow('Hook admission is paused');
    expect(store.approvals(task.id)).toEqual([]);
    await runtime.dispatch('features.set', { feature: 'hooks', enabled: true });
    const prepared = await runtime.dispatch('automation.draft.prepare', { draftId: draft.id }) as { approvalId: string };
    const approval = store.approval(prepared.approvalId);
    expect(approval).toMatchObject({ origin: 'hook', state: 'awaiting-approval' }); expect(approval.nonce).not.toBe(draft.id);
    expect(await readFile(join(task.worktreePath, 'README.md'))).toEqual(bytes);
    await expect(runtime.dispatch('automation.draft.prepare', { draftId: draft.id })).rejects.toThrow();
    await runtime.dispatch('approval.decide', { taskId: task.id, approvalId: approval.id, nonce: approval.nonce, decision: 'approve' });
    await vi.waitFor(() => expect(store.approval(approval.id).state).toBe('complete'));
    expect(await readFile(join(task.worktreePath, 'README.md'), 'utf8')).toBe('# Explicitly reviewed\n');
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM automation_runs').get()).toEqual({ count: 0 });
  });
  it('admits only one action draft per task while asynchronous preflight is pending', async () => {
    store.saveTask({ ...task, mode: 'coding' });
    const bytes = await readFile(join(task.worktreePath, 'README.md')); const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const drafts = [0, 1].map(index => ({ id: randomUUID(), source: 'hook', sourceId: randomUUID(), taskId: task.id, kind: 'actionDraft', title: `Edit ${index}`, body: '', state: 'open', createdAt: new Date().toISOString(), proposal: { tool: 'write_file', arguments: { path: 'README.md', expectedHash, content: `Edit ${index}` } } } satisfies AutomationDraft));
    for (const draft of drafts) store.db.prepare('INSERT INTO automation_drafts(id,source,source_id,data) VALUES(?,?,?,?)').run(draft.id, draft.source, draft.sourceId, JSON.stringify(draft));
    const original = repositories.prepareEdit.bind(repositories); let resume!: () => void; let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; }); const barrier = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(repositories, 'prepareEdit').mockImplementationOnce(async (...args) => { entered(); await barrier; return original(...args); });
    const first = runtime.dispatch('automation.draft.prepare', { draftId: drafts[0]!.id }) as Promise<{ approvalId: string }>;
    await entry;
    try { await expect(runtime.dispatch('automation.draft.prepare', { draftId: drafts[1]!.id })).rejects.toThrow(/active execution/); }
    finally { resume(); }
    const { approvalId } = await first; const approval = store.approval(approvalId);
    expect(store.approvals(task.id)).toHaveLength(1);
    await runtime.dispatch('approval.decide', { taskId: task.id, approvalId, nonce: approval.nonce, decision: 'reject' });
    await vi.waitFor(() => expect(store.approval(approvalId).state).toBe('rejected'));
    expect(await readFile(join(task.worktreePath, 'README.md'))).toEqual(bytes);
  });
});
