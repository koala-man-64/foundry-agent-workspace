import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { Task } from '../../packages/protocol/src/index';
import type { WorkspaceMethod } from '../../packages/protocol/src/workspace';
import { regenerating } from './oracle-node.mjs';

const stamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `12121212-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tasks = [1, 2, 3, 4].map(n => ({ id: id(n), title: `Retained ${n}`, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0,
  ...(n === 2 || n === 3 ? { mode: n === 2 ? 'coordinated' : 'coding', workspaceKind: 'git', projectPath: 'C:\\fixture-retained', worktreePath: 'C:\\fixture-retained\\wt', branch: 'codex/fixture', baseCommit: '0'.repeat(40) } : { mode: 'chat', workspaceKind: 'none' }),
  ...(n === 3 ? { parentTaskId: id(2), rootTaskId: id(2) } : {}) }));
const records = [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: id(100 + n), requestId: id(500 + n), taskId: n === 5 ? id(2) : n === 6 ? id(3) : id(1), rootTaskId: n === 5 || n === 6 ? id(2) : id(1),
  reserved: 1024, known: n === 2 || n === 5, input: n === 2 || n === 5 ? 15 : null, output: n === 2 || n === 5 ? 20 : null,
  cacheRead: n === 2 ? 5 : null, cacheCreation: n === 2 ? 2 : null, attempted: n !== 1 && n !== 4, finished: n !== 7,
  outcome: n === 7 ? 'pending' : n === 6 ? 'cancelled' : n === 2 || n === 5 ? 'completed' : 'failed',
  reason: n === 3 ? 'api_key=fixture-secret-value hidden' : n === 4 ? 'é'.repeat(499) + '😀tail' : n === 2 ? '' : null }));
const compactions = [
  { id: id(201), taskId: id(1), summary: 'plain' },
  { id: id(202), taskId: id(1), summary: 'api_key=fixture-secret-value hidden 😀' },
  { id: id(203), taskId: id(1), summary: 'a'.repeat(1999) + '😀tail' },
  { id: id(204), taskId: id(1), summary: 'A😀éB' },
  { id: id(205), taskId: id(1), summary: '\u0000'.repeat(65536) },
  { id: id(206), taskId: id(4), summary: 'other task' },
  { id: id(207), taskId: id(1), summary: 'lone \ud800 and \udfff' }
];

it('pins bounded usage/compaction projections and chunks without exposing provider state or rewriting rows', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-retained-reads-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          for (const task of tasks) store.saveTask(task as Task);
          for (const row of records) {
            if (store.schemaVersion >= 4) store.db.prepare("INSERT INTO provider_requests(request_id,task_id,root_task_id,purpose,attribution_known,created_at,attempted_at,finished_at,outcome,reserved,usage_known,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,reason) VALUES(?,?,?,'conversation',1,?,?,?,?,?,?,?,?,?,?,?)")
              .run(row.requestId, row.taskId, row.rootTaskId, stamp, row.attempted ? stamp : null, row.finished ? stamp : null, row.outcome, row.reserved, row.known ? 1 : 0, row.input, row.output, row.cacheRead, row.cacheCreation, row.reason);
            else store.db.prepare('INSERT INTO usage_records(id,task_id,request_id,reserved,prompt_tokens,completion_tokens,cache_read_tokens,cache_creation_tokens,usage_known,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
              .run(row.id, row.taskId, row.requestId, row.reserved, row.input, row.output, row.cacheRead, row.cacheCreation, row.known ? 1 : 0, row.reason, stamp);
          }
          for (const row of compactions) store.db.prepare('INSERT INTO compactions(id,task_id,from_ordinal,to_ordinal,message_ids,summary,estimated_before,estimated_after,provider_state_before,provider_state_after,created_at) VALUES(?,?,1,3,?,?,10000,2000,?,?,?)')
            .run(row.id, row.taskId, JSON.stringify([id(301), id(302), id(303)]), row.summary, '{"opaque":"never expose before"}', '{"opaque":"never expose after"}', stamp);
          const query = new WorkspaceQueries(store, new Redactor());
          const snapshot = () => JSON.stringify({ tasks: store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), usage: store.db.prepare(`SELECT * FROM ${store.schemaVersion >= 4 ? 'provider_requests' : 'usage_records'} ORDER BY rowid`).all(), compactions: store.db.prepare('SELECT * FROM compactions ORDER BY rowid').all() });
          const before = snapshot(); const steps: Array<{ method: WorkspaceMethod; params: unknown; value: unknown; error: string | null }> = [];
          const act = (method: WorkspaceMethod, params: unknown): void => {
            let value: unknown = null; let error: string | null = null;
            try { value = query.dispatch(method, params); } catch (cause) { error = (cause as Error).message; }
            steps.push({ method, params, value, error }); expect(snapshot()).toBe(before);
          };
          for (const taskId of [id(1), id(2), id(3), id(4), id(99)]) for (const limit of [1, 2, 50]) for (const before of [undefined, 0, 3]) act('task.usageRecords', { taskId, limit, ...(before === undefined ? {} : { before }) });
          for (const taskId of [id(1), id(4), id(99)]) for (const limit of [1, 2, 50]) for (const before of [undefined, 0, 3]) act('task.compactions', { taskId, limit, ...(before === undefined ? {} : { before }) });
          for (const offset of [0, 1, 2, 5, 7, 8, 9]) for (const maxBytes of [1, 2, 4, 65536]) act('task.compactionContent', { taskId: id(1), compactionId: id(204), offset, maxBytes });
          for (const compactionId of [id(201), id(202), id(203), id(205), id(206), id(207), id(299)]) act('task.compactionContent', { taskId: id(1), compactionId, offset: 0, maxBytes: 65536 });
          act('task.compactionContent', { taskId: id(1), compactionId: id(205), offset: 65536, maxBytes: 1 });
          act('task.compactionContent', { taskId: id(1), compactionId: id(205), offset: 65537, maxBytes: 1 });
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { stamp, tasks, records, compactions, cases };
    if (regenerating('P2_WRITE_RETAINED_READS')) writeFileSync('tests/p2/retained-read-page-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/retained-read-page-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
