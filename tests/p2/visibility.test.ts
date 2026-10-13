import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { newFeatureAdmission } from '../../packages/runtime/src/feature-admission';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { Task } from '../../packages/protocol/src/index';

const stamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `13131313-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tasks = [1, 2, 3, 4].map(n => ({ id: id(n), title: `Visible ${n}`, profileId: FAKE_PROFILE_ID, status: n === 1 ? 'running' : 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0,
  ...(n === 2 || n === 3 ? { mode: n === 2 ? 'coordinated' : 'coding', workspaceKind: 'git', projectPath: 'C:\\fixture-visibility', worktreePath: 'C:\\fixture-visibility\\wt', branch: 'codex/fixture', baseCommit: '0'.repeat(40) } : { mode: 'chat', workspaceKind: 'none' }),
  ...(n === 3 ? { parentTaskId: id(2), rootTaskId: id(2) } : {}), ...(n === 4 ? { archivedAt: '', opaque: { retained: true } } : {}) }));

it('pins feature admission and atomic visibility without dismissing pending obligations', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-visibility-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          for (const task of tasks) store.saveTask(task as Task);
          store.db.prepare("INSERT INTO intents(id,kind,state,data) VALUES(?,'tool.approval','awaiting-approval',?)").run(id(101), JSON.stringify({ taskId: id(1), retained: 'pending' }));
          store.db.prepare("INSERT INTO intents(id,kind,state,data) VALUES(?,'git.push','unknown',?)").run(id(102), JSON.stringify({ taskId: id(2), retained: 'unknown' }));
          const preserved = JSON.stringify(store.db.prepare("SELECT * FROM intents WHERE id LIKE '13131313-%' ORDER BY rowid").all());
          const features = newFeatureAdmission(store); const query = new WorkspaceQueries(store, new Redactor());
          const steps: Array<{ method: string; params: unknown; value: unknown; error: string | null; tasks: unknown; features: unknown }> = [];
          const act = (method: string, params: Record<string, unknown>): void => {
            let value: unknown = null; let error: string | null = null;
            try {
              if (method === 'features.get') value = features.snapshot();
              else if (method === 'features.set') value = features.set(params as { feature: 'archive'; enabled: boolean });
              else {
                if (params.archived && !features.get('archive').enabled) throw new Error('Archive admission is paused. Restore and pending-work access remain available.');
                value = query.dispatch('task.setArchived', params);
              }
            } catch (cause) { error = (cause as Error).message; }
            expect(JSON.stringify(store.db.prepare("SELECT * FROM intents WHERE id LIKE '13131313-%' ORDER BY rowid").all())).toBe(preserved);
            steps.push({ method, params, value, error, tasks: store.db.prepare("SELECT data FROM tasks WHERE id LIKE '13131313-%' ORDER BY rowid").all().map(row => JSON.parse((row as { data: string }).data)), features: features.snapshot() });
          };
          act('features.get', {});
          act('features.set', { feature: 'archive', enabled: true });
          act('task.setArchived', { taskId: id(1), archived: true });
          act('task.setArchived', { taskId: id(1), archived: true });
          act('task.setArchived', { taskId: id(3), archived: false });
          act('task.setArchived', { taskId: id(2), archived: true });
          act('features.set', { feature: 'archive', enabled: false });
          act('task.setArchived', { taskId: id(4), archived: true });
          act('task.setArchived', { taskId: id(2), archived: false });
          act('task.setArchived', { taskId: id(1), archived: false });
          act('features.set', { feature: 'archive', enabled: false, reason: 'runtime-fault' });
          act('features.set', { feature: 'archive', enabled: false, reason: 'migration-required' });
          act('features.set', { feature: 'hooks', enabled: false });
          act('features.set', { feature: 'scheduling', enabled: false, reason: 'runtime-fault' });
          act('features.set', { feature: 'archive', enabled: true, reason: 'migration-required' });
          act('task.setArchived', { taskId: id(4), archived: true });
          act('task.setArchived', { taskId: id(4), archived: false });
          act('task.setArchived', { taskId: id(99), archived: false });
          for (let n = 0; n < 56; n++) act('features.set', { feature: 'archive', enabled: n % 2 === 0 });
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { stamp, tasks, cases };
    if (process.env.P2_WRITE_VISIBILITY === '1') writeFileSync('tests/p2/visibility-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/visibility-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
