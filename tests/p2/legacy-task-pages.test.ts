import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { Task } from '../../packages/protocol/src/index';
import { WorkspaceRpc, type TaskPage } from '../../packages/protocol/src/workspace';
import { regenerating } from './oracle-node.mjs';

const count = 20000;
const key = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-01-02T03:04:05.678Z';
const taskAt = (n: number): Task => ({ id: key(n + 1), title: `Large legacy ${n}`, profileId: FAKE_PROFILE_ID, status: n % 3 === 0 ? 'failed' : 'idle',
  createdAt: new Date(Date.UTC(2024, 0, 1) + (n * 7919 % count) * 1000).toISOString(), updatedAt: new Date(Date.UTC(2024, 0, 1) + (n * 3571 % count) * 1000).toISOString(),
  tokenBudget: 100000, usedTokens: 0, mode: n % 2 === 0 ? 'chat' : 'coding', workspaceKind: 'git', projectPath: 'C:\\fixture-legacy-memory',
  worktreePath: 'C:\\fixture-legacy-memory\\wt', branch: 'codex/fixture', baseCommit: '0'.repeat(40),
  ...(n % 5 === 0 ? { archivedAt: stamp } : {}), ...(n % 17 === 0 ? { parentTaskId: key(count + 1) } : {}),
  ...{ retained: { index: n, opaque: 'x'.repeat(1024) } } });

// Independent reference is the pre-correction whole-history algorithm. The
// production implementation must agree while never materializing allTasks().
function reference(all: Task[], input: unknown): TaskPage {
  const p = WorkspaceRpc['workspace.tasks'].parse(input);
  const field = p.sort === 'created' ? 'createdAt' : 'updatedAt';
  const fingerprint = createHash('sha256').update(JSON.stringify({ visibility: p.visibility, sort: p.sort, projectPath: p.projectPath ?? null, projectId: p.projectId ?? null, mode: p.mode ?? null, status: p.status ?? null, from: p.from ?? null, to: p.to ?? null })).digest('hex');
  const sorted = all.filter(task => !task.parentTaskId && task.projectPath === p.projectPath
    && (p.visibility === 'all' || (p.visibility === 'active' ? !task.archivedAt : !!task.archivedAt))
    && (!p.mode || (task.mode ?? 'chat') === p.mode) && (!p.status || task.status === p.status)
    && (!p.from || task[field] >= p.from) && (!p.to || task[field] <= p.to))
    .sort((left, right) => right[field].localeCompare(left[field]) || right.id.localeCompare(left.id));
  const highWater = p.cursor ? { at: p.cursor.highWaterAt, id: p.cursor.highWaterId } : { at: sorted[0]?.[field] ?? '', id: sorted[0]?.id ?? '' };
  const candidates = sorted.filter(task => !p.cursor || task[field] < p.cursor.at || task[field] === p.cursor.at && task.id < p.cursor.id).slice(0, p.limit + 1);
  const tasks = candidates.slice(0, p.limit); const last = tasks.at(-1);
  return { tasks, nextCursor: p.sort === 'created' && last && candidates.length > tasks.length ? { at: last.createdAt, id: last.id, highWaterAt: highWater.at, highWaterId: highWater.id, filterHash: fingerprint } : null, visibility: p.visibility };
}

it('streams 20000 legacy tasks with identical whole-history reference ordering and cursors', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = ['v1', 'v2', 'v3', 'v4'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-large-legacy-'));
      try {
        for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          const insert = store.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?)');
          store.db.transaction(() => { for (let n = 0; n < count; n++) { const task = taskAt(n); insert.run(task.id, JSON.stringify(task)); } })();
          const all = store.allTasks(); const query = new WorkspaceQueries(store, new Redactor());
          vi.spyOn(store, 'allTasks').mockImplementation(() => { throw new Error('Legacy query must stream retained rows.'); });
          const steps: Array<{ params: unknown; ids: string[]; hash: string }> = [];
          const act = (params: unknown): TaskPage => {
            const expected = reference(all, params); const actual = query.dispatch('workspace.tasks', params) as TaskPage;
            expect(actual).toEqual(expected);
            steps.push({ params, ids: actual.tasks.map(task => task.id), hash: createHash('sha256').update(JSON.stringify(actual)).digest('hex') }); return actual;
          };
          for (const visibility of ['active', 'archived', 'all']) for (const sort of ['created', 'recent']) {
            const p = { visibility, sort, projectPath: 'C:\\fixture-legacy-memory', limit: 50 };
            const first = act(p); if (first.nextCursor) act({ ...p, cursor: first.nextCursor });
          }
          act({ projectPath: 'C:\\fixture-legacy-memory', visibility: 'all', mode: 'chat', status: 'failed', limit: 2, from: '2024-01-01T01:00:00.000Z', to: '2024-01-01T04:00:00.000Z' });
          store.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?)').run(key(count + 2), '{bad');
          expect(() => query.dispatch('workspace.tasks', { projectPath: 'C:\\fixture-legacy-memory', limit: 1 })).toThrow(SyntaxError);
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { count, stamp, cases };
    if (regenerating('P2_WRITE_LEGACY_MEMORY')) writeFileSync('tests/p2/legacy-task-page-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/legacy-task-page-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
}, 60000);
