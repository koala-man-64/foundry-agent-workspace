import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { RpcMethod, Task, WorkspaceEvent } from '../../packages/protocol/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { normalize, sha256File } from './repository-fixture';

// Approval records through the shipping RuntimeService, over fresh data and disposable copies of all six fixture eras:
// task.approvals, approval.get and approval.content (read projections that never rewrite a row), then approval.reconcile
// (read-only reconciliation of unknown outcomes) with the approval row and every event row it adds. The C# suite
// (ApprovalTests) seeds the same rows into the same copies and replays every step through DevelopmentChat. Rowids,
// event sequences and the clock agree because both runtimes insert the same rows in the same order. Placeholders:
// {scratch} {scratch-json}; in tasks and approvals, {work} is the seeded worktree folder.
const stamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `13131313-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const git = { workspaceKind: 'git', projectPath: '{work}', worktreePath: '{work}', branch: 'codex/approvals', baseCommit: '0'.repeat(40) };
const tasks = [
  { id: id(1), title: 'Approvals', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode: 'coding', ...git },
  { id: id(2), title: 'Plain chat', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode: 'chat', workspaceKind: 'none' },
  { id: id(3), title: 'Other', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode: 'coding', ...git },
];
// The worktree files the edit reconciliations read.
const files: Record<string, string> = { 'a9.txt': 'nine after\n', 'a10.txt': 'ten before\n', 'a11.txt': 'eleven elsewhere\n' };
const base = (n: number, taskId: string, tool: string, state: string) => ({ id: id(200 + n), taskId, toolCallId: `call-${n}`, nonce: 'n'.repeat(16) + n, tool, state, createdAt: stamp });
const edit = (n: number, taskId: string, state: string, path: string, before: string, after: string, extra: Record<string, unknown> = {}) => ({
  ...base(n, taskId, 'replace_text', state), summary: `Edit ${path}`, path, before, after, expectedHash: sha(before), resultingHash: sha(after), fingerprint: sha(`${n}`), ...extra });
const command = (n: number, state: string, extra: Record<string, unknown> = {}) => ({ ...base(n, id(1), 'run_command', state), summary: 'Run this exact PowerShell command with your Windows privileges.',
  command: "Write-Output 'x'", cwd: 'C:\\fixture-work', shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', environment: { A: '1' }, timeoutMs: 10000, fingerprint: sha(`${n}`), ...extra });
const approvals: { id: string; state: string; data: unknown }[] = [
  edit(1, id(1), 'awaiting-approval', 'README.md', 'hello\n', 'hello\nmore\n'),
  command(2, 'complete', { result: { content: '{"stdout":"x\\r\\n","stderr":"","exitCode":0}', isError: false, exitCode: 0, cleanupVerified: true } }),
  edit(3, id(1), 'rejected', 'secret.txt', 'old\n', 'api_key=fixture-secret-value\n', { summary: 'Edit with token=fixture-secret-value' }),
  { ...edit(4, id(1), 'complete', 'p/'.repeat(600) + 'x', 'small\n', 'a'.repeat(140000), { summary: '\u00e9'.repeat(600), expectedHash: null, origin: 'hook' }),
    rootTaskId: id(1), assignmentId: null, generation: 3, targetLabel: 'child', evidenceId: id(900), environment: { B: '2' } },
  { ...base(5, id(1), 'mcp__fixture__write_note', 'unknown'), summary: 'Call external MCP tool "write_note" on server "Fixture".', fingerprint: sha('5'),
    mcp: { serverId: id(950), serverKey: 'fixture', serverName: 'Fixture', tool: 'write_note', arguments: '{"text":"hi \u00e9\u00e9"}' } },
  { ...base(6, id(1), 'browser_click', 'unknown'), summary: 'Click in the attached tab.', fingerprint: sha('6'), browser: { prepared: { tabId: 'tab-1', action: 'click' } } },
  { ...base(7, id(1), 'handoff', 'unknown'), summary: 'Commit the child handoff.', fingerprint: sha('7'), handoff: { operationId: id(970), branch: 'b', expectedHead: '0'.repeat(40), paths: ['a.txt'], manifestSha256: sha('m'), message: 'm', patch: 'diff --git a/a.txt b/a.txt\n+\u00e9\n', patchTruncated: false, gitPath: 'C:\\git.exe', gitSha256: sha('g') } },
  { ...base(8, id(1), 'integrate', 'unknown'), summary: 'Integrate the child result.', fingerprint: sha('8'), integration: { operationId: id(980), kind: 'cherry-pick', resultId: id(981), assignmentId: id(982), sourceSha: '1'.repeat(40), expectedHead: '0'.repeat(40), expectedTree: '2'.repeat(40), manifestSha256: sha('i'), resolvedTree: null, changedPaths: ['a.txt'], patch: 'integration patch', patchTruncated: false, gitPath: 'C:\\git.exe', gitSha256: sha('g') } },
  edit(9, id(1), 'unknown', 'a9.txt', 'nine before\n', 'nine after\n'),
  edit(10, id(1), 'unknown', 'a10.txt', 'ten before\n', 'ten after\n'),
  edit(11, id(1), 'unknown', 'a11.txt', 'eleven before\n', 'eleven after\n'),
  edit(12, id(1), 'unknown', 'a12.txt', 'twelve before\n', 'twelve after\n'),
  edit(13, id(2), 'unknown', 'a13.txt', 'thirteen before\n', 'thirteen after\n'),
  command(14, 'unknown', { result: { content: 'Command outcome unknown.', isError: true, cleanupVerified: false } }),
  edit(15, id(3), 'unknown', 'a15.txt', 'x\n', 'y\n'),
  edit(16, id(1), 'complete', 'lone.txt', 'lone \ud800 before', 'lone \udfff after'),
  edit(19, id(1), 'complete', 'a19.txt', 'done before\n', 'done after\n'),
  { ...edit(20, id(1), 'unknown', 'a20.txt', '', 'created\n'), expectedHash: null, resultingHash: undefined, summary: 'Create a20.txt' },
].map(value => ({ id: value.id, state: value.state, data: value }));
// A row whose stored document has no state (the column decides), and one that is not JSON at all.
approvals.push({ id: id(217), state: 'awaiting-approval', data: (() => { const { state: _, ...rest } = edit(17, id(1), 'awaiting-approval', 'b.txt', 'b\n', 'bb\n'); return rest; })() });
approvals.push({ id: id(218), state: 'awaiting-approval', data: 'not json' });

type Step = { method: RpcMethod; params: Record<string, unknown> };
const reads: Step[] = [
  ...[id(1), id(2), id(3), id(99)].flatMap(taskId => [1, 2, 50].map(limit => ({ method: 'task.approvals' as const, params: { taskId, limit } }))),
  ...approvals.filter(item => item.id !== id(218)).map(item => ({ method: 'approval.get' as const, params: { taskId: id(1), approvalId: item.id } })),
  { method: 'approval.get', params: { taskId: id(3), approvalId: id(215) } }, { method: 'approval.get', params: { taskId: id(1), approvalId: id(299) } },
  ...['full', 'summary', 'before', 'after', 'command', 'result.content', 'handoff.patch', 'integration.patch', 'mcp.arguments'].flatMap(field =>
    [201, 202, 203, 205, 207, 208, 216].map(n => ({ method: 'approval.content' as const, params: { taskId: id(1), approvalId: id(n), field } }))),
  ...[0, 1, 2, 3, 4].flatMap(offset => [1, 2, 3, 4, 32768].map(maxBytes => ({ method: 'approval.content' as const, params: { taskId: id(1), approvalId: id(204), field: 'summary', offset, maxBytes } }))),
  ...[0, 32768, 139999, 140000, 140001].map(offset => ({ method: 'approval.content' as const, params: { taskId: id(1), approvalId: id(204), field: 'after', offset } })),
  { method: 'approval.content', params: { taskId: id(3), approvalId: id(201), field: 'full' } },
];
const reconciles: Step[] = [215, 219, 299, 209, 209, 210, 211, 211, 212, 213, 214, 205, 206, 207, 208, 220, 211].map(n => ({ method: 'approval.reconcile' as const, params: { taskId: id(1), approvalId: id(n) } }));
reconciles.splice(10, 0, { method: 'approval.reconcile', params: { taskId: id(2), approvalId: id(213) } });

it('pins approval records, projections and read-only reconciliation through the shipping Node authority', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = [];
    for (const era of ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal']) {
      const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'foundry-p2-approvals-')));
      const work = join(scratch, 'work'); mkdirSync(work);
      for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
      const expand = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll('{work}', work.replaceAll('\\', '\\\\')));
      const data = join(scratch, 'data'); mkdirSync(data);
      if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(data, file));
      const store = new Store(join(data, 'workspace.db'));
      const notifications: WorkspaceEvent[] = [];
      const service = new RuntimeService(store, new RepositoryService(join(data, 'wt')), event => notifications.push(event));
      try {
        const existing = (store.db.prepare("SELECT DISTINCT json_extract(data,'$.taskId') AS taskId FROM intents WHERE kind='tool.approval' AND json_valid(data) ORDER BY rowid").all() as { taskId: string | null }[])
          .map(row => row.taskId).filter((value): value is string => typeof value === 'string');
        const existingIds = (store.db.prepare("SELECT id FROM intents WHERE kind='tool.approval' AND json_valid(data) ORDER BY rowid").all() as { id: string }[]).map(row => row.id);
        for (const task of tasks) store.saveTask(expand(task) as Task);
        for (const item of approvals) store.db.prepare("INSERT INTO intents VALUES (?, 'tool.approval', ?, ?)").run(item.id, typeof item.data === 'string' ? item.data : JSON.stringify(expand(item.data)), item.state);
        const clean = (value: unknown) => normalize(value, scratch);
        const rows = () => ({ intents: store.db.prepare("SELECT rowid AS _rowid,* FROM intents WHERE kind='tool.approval' ORDER BY rowid").all(), events: store.db.prepare('SELECT * FROM events ORDER BY sequence').all() });
        const act = async (step: Step) => {
          let value: unknown = null; let error: string | null = null;
          try { value = await service.dispatch(step.method, step.params); } catch (cause) { error = (cause as Error).message; }
          return { value: clean(value), error };
        };
        const before = JSON.stringify(rows());
        const steps: unknown[] = [];
        // Every era's own approvals, then the seeded ones, including full keyset traversal at limit 2.
        for (const taskId of existing) steps.push({ method: 'task.approvals', params: { taskId, limit: 50 }, ...await act({ method: 'task.approvals', params: { taskId, limit: 50 } }) });
        for (const approvalId of existingIds) {
          const taskId = (store.db.prepare("SELECT json_extract(data,'$.taskId') AS taskId FROM intents WHERE id = ?").get(approvalId) as { taskId: string }).taskId;
          steps.push({ method: 'approval.get', params: { taskId, approvalId }, ...await act({ method: 'approval.get', params: { taskId, approvalId } }) });
        }
        let cursor: number | null | undefined;
        do {
          const params = { taskId: id(1), limit: 2, ...(cursor ? { before: cursor } : {}) };
          const result = await act({ method: 'task.approvals', params });
          steps.push({ method: 'task.approvals', params, ...result });
          cursor = (result.value as { nextBefore: number | null } | null)?.nextBefore;
        } while (cursor);
        for (const step of reads) steps.push({ ...step, ...await act(step) });
        expect(JSON.stringify(rows())).toBe(before);
        const reconciled: unknown[] = [];
        for (const step of reconciles) {
          const eventsBefore = (store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events').get() as { value: number }).value;
          const result = await act(step);
          reconciled.push({ ...step, ...result,
            row: clean(store.db.prepare('SELECT * FROM intents WHERE id = ?').get(step.params.approvalId) ?? null),
            events: clean(store.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence').all(eventsBefore)) });
        }
        cases.push({ era, schema: store.schemaVersion, steps, reconciled });
      } finally { await service.shutdown(); rmSync(scratch, { recursive: true, force: true }); }
    }
    const corpus = {
      schemaVersion: 1,
      oracle: { sources: ['packages/runtime/src/workspace-queries.ts', 'packages/runtime/src/tool-runtime.ts', 'packages/runtime/src/store.ts', 'packages/runtime/src/service.ts', 'packages/runtime/src/redaction.ts', 'packages/runtime/src/repository.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
      stamp, tasks, files, approvals, reads, reconciles, cases,
    };
    const target = 'tests/p2/approval-vectors.json';
    if (process.env.P2_WRITE_APPROVALS === '1') writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(JSON.parse(JSON.stringify(corpus)));
  } finally { vi.useRealTimers(); }
}, 300_000);
