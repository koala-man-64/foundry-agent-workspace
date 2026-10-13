import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { Task } from '../../packages/protocol/src/index';
import type { ActionPage } from '../../packages/protocol/src/workspace';

const stamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `14141414-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tasks = [1, 2, 3, 4].map(n => ({ id: id(n), title: `Inbox ${n}`, profileId: FAKE_PROFILE_ID, status: n === 1 ? 'running' : 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0,
  ...(n === 2 || n === 3 ? { mode: n === 2 ? 'coordinated' : 'coding', workspaceKind: 'git', projectPath: 'C:\\fixture-inbox', worktreePath: 'C:\\fixture-inbox\\wt', branch: 'codex/fixture', baseCommit: '0'.repeat(40) } : { mode: 'chat', workspaceKind: 'none' }),
  ...(n === 3 ? { parentTaskId: id(2), rootTaskId: id(2) } : {}), ...(n === 2 ? { archivedAt: stamp } : {}) }));
type Statement = { current?: boolean; sql: string; values: unknown[] };
const statements: Statement[] = [];
for (const [n, state] of ['awaiting-approval', 'unknown', 'approved', 'executing', 'complete'].entries()) statements.push({ sql: 'INSERT INTO intents(id,kind,state,data) VALUES(?,?,?,?)', values: [id(101 + n), 'tool.approval', state, JSON.stringify({ taskId: n === 1 ? id(3) : id(1), createdAt: stamp, secret: 'never expose approval evidence' })] });
statements.push({ sql: 'INSERT INTO intents(id,kind,state,data) VALUES(?,?,?,?)', values: [id(110), 'api_key=fixture-secret-value', 'unknown', JSON.stringify({ rootTaskId: id(2), createdAt: stamp })] });
statements.push({ sql: 'INSERT INTO intents(id,kind,state,data) VALUES(?,?,?,?)', values: [id(111), 'git.push', 'unknown', '{'] });
statements.push({ sql: 'INSERT INTO intents(id,kind,state,data) VALUES(?,?,?,?)', values: [id(112), 'git.commit', 'unknown', JSON.stringify({ taskId: id(99), createdAt: stamp })] });
statements.push({ current: true, sql: 'INSERT INTO agent_runs(task_id,root_task_id,role,lifecycle,wait_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', values: [id(2), id(2), 'coordinator', 'waiting', 'api_key=fixture-secret-value ' + 'é'.repeat(60) + '😀', stamp, stamp] });
for (const [n, kind] of ['promptDraft', 'actionDraft', 'otherDraft'].entries()) statements.push({ current: true, sql: 'INSERT INTO automation_drafts(id,source,source_id,data) VALUES(?,?,?,?)', values: [id(201 + n), 'fixture', id(201 + n), JSON.stringify({ taskId: id(3), state: 'open', kind, createdAt: stamp, secret: 'never expose draft content' })] });
statements.push({ current: true, sql: 'INSERT INTO automation_drafts(id,source,source_id,data) VALUES(?,?,?,?)', values: [id(205), 'fixture', id(205), '{'] });
for (const [n, passed] of [false, true, false].entries()) statements.push({ current: true, sql: "INSERT INTO validation_evidence(id,root_task_id,run_task_id,approval_id,kind,command,cwd,head,tree,clean,state_fingerprint,exit_code,cleanup_verified,passed,created_at) VALUES(?,?,?,?, 'combined','fixture','fixture','head','tree',1,'fixture',0,1,?,?)", values: [id(301 + n), id(2), id(2), id(801 + n), Number(passed), n === 2 ? '2026-01-02T03:04:06.678Z' : stamp] });
for (const [n, at] of ['2025-12-03T03:04:05.677Z', '2025-12-03T03:04:05.678Z', stamp].entries()) statements.push({ sql: 'INSERT INTO events(type,task_id,data,created_at) VALUES(?,?,?,?)', values: [n === 2 ? 'task.stopped' : 'task.completed', id(3), '{}', at] });

it('pins global Inbox tiers, archived obligations, root mapping, cursors and counts without mutations', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-actions-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          for (const task of tasks) store.saveTask(task as Task);
          for (const s of statements) if (!s.current || store.schemaVersion >= 5) store.db.prepare(s.sql).run(...s.values);
          const tables = ['tasks', 'intents', 'events', ...(store.schemaVersion >= 5 ? ['agent_runs', 'validation_evidence', 'automation_drafts'] : [])];
          const snapshot = () => JSON.stringify(Object.fromEntries(tables.map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
          const before = snapshot(); const query = new WorkspaceQueries(store, new Redactor()); const steps: Array<{ params: unknown; value: unknown }> = [];
          for (const limit of [1, 2, 5, 50]) {
            let cursor: ActionPage['nextCursor'] = null; const seen = new Set<string>();
            for (let n = 0; n < 100; n++) {
              const params = { limit, ...(cursor ? { cursor } : {}) }; const value = query.dispatch('workspace.actions', params) as ActionPage;
              for (const item of value.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
              steps.push({ params, value }); expect(snapshot()).toBe(before);
              cursor = value.nextCursor; if (!cursor) break; expect(n).toBeLessThan(99);
            }
          }
          for (const tier of [0, 1, 2]) {
            const params = { limit: 50, cursor: { tier, at: stamp + '\u0000suffix', id: 'zzzz' } };
            steps.push({ params, value: query.dispatch('workspace.actions', params) }); expect(snapshot()).toBe(before);
          }
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { stamp, tasks, statements, cases };
    if (process.env.P2_WRITE_ACTIONS === '1') writeFileSync('tests/p2/action-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/action-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
