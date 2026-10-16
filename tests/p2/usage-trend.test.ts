import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { Task } from '../../packages/protocol/src/index';
import type { UsageTrendPage } from '../../packages/protocol/src/workspace';

const stamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `16161616-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tasks = [1, 2, 3, 4, 5].map(n => ({ id: id(n), title: `Trend ${n}`, ...(n === 5 ? {} : { profileId: n === 3 ? id(995) : FAKE_PROFILE_ID }), status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0,
  ...(n === 2 || n === 3 ? { mode: n === 2 ? 'coordinated' : 'coding', workspaceKind: 'git', projectPath: 'C:\\fixture-trend', worktreePath: 'C:\\fixture-trend\\wt', branch: 'codex/fixture', baseCommit: '0'.repeat(40) } : { mode: 'chat', workspaceKind: 'none' }),
  ...(n === 3 ? { parentTaskId: id(2), rootTaskId: id(2) } : {}) }));
const records = [
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 11, output: 7, cacheRead: 3, cacheCreation: 2, at: '2025-12-31T23:59:59.999Z' },
  { task: 1, outcome: 'failed', known: false, attempted: true, attribution: true, at: '2026-01-01T00:00:00.000Z' },
  { task: 1, outcome: 'cancelled', known: false, attempted: false, attribution: true },
  { task: 1, outcome: 'pending', known: false, attempted: false, attribution: true },
  { task: 2, outcome: 'completed', known: true, attempted: true, attribution: true, input: 20, output: 5 },
  { task: 3, outcome: 'failed', known: false, attempted: true, attribution: true },
  { task: 3, outcome: 'completed', known: false, attempted: false, attribution: false },
  { task: 4, outcome: 'pending', known: true, attempted: true, attribution: true, input: 100, output: 50, cacheRead: 5, cacheCreation: 2 },
  { task: 5, outcome: 'completed', known: true, attempted: true, attribution: true, input: 5, output: 3 },
  { task: null, outcome: 'completed', known: true, attempted: true, attribution: true, input: 13, output: 8 },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 999, output: 999, at: '2026-01-03T00:00:00.000Z' },
  { task: 4, outcome: 'completed', known: true, attempted: true, attribution: true, input: Number.MAX_SAFE_INTEGER, output: 3 },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 17, output: 19, at: '2026-01-02T03:04:05.100Z' },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 23, output: 29, at: '2026-01-02T03:04:05.1001Z' },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 31, output: 37, at: '2026-01-02T03:04:05.12000000000000000000000001Z' },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 41, output: 0, at: '2026-01-01T23:59:59.999999999Z' },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 43, output: 0, at: '2026-01-02T00:00:00Z' },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 47, output: 0, at: '0000-02-29T23:59:59.9999Z' },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 49, output: 0, at: '0000-03-01T00:00:00Z' },
  { task: 1, outcome: 'completed', known: true, attempted: true, attribution: true, input: 53, output: 0, at: '9999-12-31T23:59:59.999Z' }
];
const statements = records.flatMap((r, n) => {
  const taskId = r.task === null ? null : id(r.task); const root = r.task === 3 ? id(2) : taskId;
  const profile = r.task === 5 ? null : r.task === 3 ? id(995) : FAKE_PROFILE_ID;
  const at = r.at ?? stamp; const reserved = 2 ** (n + 7); const known = Number(r.known); const input = r.input ?? null; const output = r.output ?? null;
  const cacheRead = r.cacheRead ?? null; const cacheCreation = r.cacheCreation ?? null;
  return [
    { current: true, sql: "INSERT INTO provider_requests(request_id,task_id,root_task_id,profile_id,purpose,attribution_known,created_at,attempted_at,finished_at,outcome,reserved,usage_known,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reason) VALUES(?,?,?,?,'conversation',?,?,?,?,?,?,?,?,?,?,?,?)", values: [id(501 + n), taskId, root, profile, Number(r.attribution), at, r.attempted ? at : null, r.outcome === 'pending' ? null : at, r.outcome, reserved, known, input, output, cacheRead, cacheCreation, 'api_key=retained-secret-not-output'] },
    ...(taskId === null ? [] : [{ current: false, sql: 'INSERT INTO usage_records(id,task_id,request_id,reserved,prompt_tokens,completion_tokens,cache_read_tokens,cache_creation_tokens,usage_known,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', values: [id(101 + n), taskId, id(501 + n), reserved, input, output, cacheRead, cacheCreation, known, 'api_key=retained-secret-not-output', at] }])
  ];
});

it('pins era-aware usage totals, attribution, grouping, root filters, dates and cursors without writes', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-usage-trend-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          for (const task of tasks) store.saveTask(task as Task);
          for (const s of statements) if (s.current === (store.schemaVersion >= 4)) store.db.prepare(s.sql).run(...s.values);
          const snapshot = () => JSON.stringify({ tasks: store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), usage: store.db.prepare(`SELECT * FROM ${store.schemaVersion >= 4 ? 'provider_requests' : 'usage_records'} ORDER BY rowid`).all() });
          const before = snapshot(); const query = new WorkspaceQueries(store, new Redactor()); const steps: Array<{ params: unknown; value: unknown; error: string | null }> = [];
          const act = (params: Record<string, unknown>): UsageTrendPage | null => {
            let value: UsageTrendPage | null = null; let error: string | null = null;
            try { value = query.dispatch('workspace.usageTrend', params) as UsageTrendPage; } catch (cause) { error = (cause as Error).message; }
            steps.push({ params, value, error }); expect(snapshot()).toBe(before); return value;
          };
          for (const groupBy of ['day', 'profile', 'task']) for (const filter of [{}, { taskId: id(1) }, { taskId: id(2) }, { taskId: id(3) }, { profileId: FAKE_PROFILE_ID }, { profileId: id(995) }, { profileId: id(998) }, { taskId: id(2), profileId: id(995) }]) for (const limit of [1, 2, 50]) {
            let after: string | null = null;
            for (let n = 0; n < 100; n++) {
              const result = act({ groupBy, ...filter, limit, ...(after === null ? {} : { after }) }); expect(result).not.toBeNull();
              after = result!.nextAfter; if (after === null) break; expect(n).toBeLessThan(99);
            }
          }
          for (const groupBy of ['day', 'profile', 'task']) {
            act({ groupBy, from: stamp, to: stamp });
            act({ groupBy, from: '2026-01-03T00:00:00.000Z', to: '2026-01-04T00:00:00.000Z' });
            act({ groupBy, from: '2026-01-03T00:00:00.000Z', to: stamp });
            act({ groupBy, taskId: id(999) });
            act({ groupBy, after: 'zzzz\u0000suffix' });
            // Independent semantic assertions precede the regenerated corpus:
            // fractional bounds compare instants, not their string spelling.
            const range = (from: string, to: string, prompt: number): void => {
              const result = act({ groupBy, taskId: id(1), from, to }); expect(result).not.toBeNull();
              expect(result!.buckets.reduce((sum, bucket) => sum + bucket.observedPrompt, 0)).toBe(prompt);
            };
            range('2026-01-02T03:04:05.1Z', '2026-01-02T03:04:05.12Z', 40);
            range('2026-01-02T03:04:05.100000Z', '2026-01-02T03:04:05.100Z', 17);
            range('2026-01-02T03:04:05.100000000000000000000000000000000000000001Z', '2026-01-02T03:04:05.1001Z', 23);
            range('2026-01-02T03:04:05.12000000000000000000000001Z', '2026-01-02T03:04:05.120000000000000000000000010Z', 31);
            range('2026-01-02T03:04:05Z', '2026-01-02T03:04:05.099999999999Z', 0);
            range('2026-01-01T23:59:59.99999Z', '2026-01-02T00:00:00.000000Z', 84);
            range('0000-02-29T23:59:59.999Z', '0000-03-01T00:00:00Z', 96);
            range('9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.99999999999999999Z', 53);
            const reversed = act({ groupBy, taskId: id(1), from: '2026-01-02T03:04:05.10001Z', to: '2026-01-02T03:04:05.10000Z' });
            expect(reversed).toBeNull(); expect(steps.at(-1)!.error).toBe('Usage trend start must be before end.');
          }
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { stamp, tasks, statements, cases };
    if (process.env.P2_WRITE_USAGE_TREND === '1') writeFileSync('tests/p2/usage-trend-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/usage-trend-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
