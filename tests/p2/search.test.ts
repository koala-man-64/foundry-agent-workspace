import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { Task, Message } from '../../packages/protocol/src/index';
import type { SearchHit, SearchCursor } from '../../packages/protocol/src/workspace';

const stamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `15151515-0000-4000-8000-${String(n).padStart(12, '0')}`;
const titles = ['Alpha root', 'Alpha archived root', 'Alpha child', 'alpha echo', 'ΟΣ İstanbul', 'Mixed punctuation'];
const tasks = titles.map((title, n) => ({ id: id(n + 1), title, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0,
  ...(n === 1 || n === 2 ? { mode: n === 1 ? 'coordinated' : 'coding', workspaceKind: 'git', projectPath: 'C:\\fixture-search', projectId: id(999), worktreePath: 'C:\\fixture-search\\wt', branch: 'codex/fixture', baseCommit: '0'.repeat(40) } : { mode: 'chat', workspaceKind: 'none' }),
  ...(n === 1 ? { archivedAt: stamp } : {}), ...(n === 2 ? { parentTaskId: id(2), rootTaskId: id(2) } : {}) }));
const messages = ['alpha beta 😀', 'alpha api_key=fixture-secret-value hidden', 'alpha child beta', 'ALPHA ' + 'é'.repeat(249) + '😀tail', 'one two three four five six seven eight nine', 'quote "alpha" beta'].map((content, n) => ({ id: id(101 + n), taskId: id(n % 4 + 1), role: n % 2 ? 'assistant' : 'user', content, status: 'complete', createdAt: stamp, opaque: { provider: 'never expose' } }));
const filters = [{}, { visibility: 'active' }, { visibility: 'archived' }, { mode: 'coordinated' }, { status: 'idle' }, { status: 'failed' }, { projectPath: 'C:\\fixture-search' }, { projectId: id(999) }, { from: stamp, to: stamp }];

it('pins search phases, filters, cursors, locale/FTS differences and immutable source rows', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-search-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          for (const task of tasks) store.saveTask(task as Task); for (const message of messages) store.saveMessage(message as Message);
          const query = new WorkspaceQueries(store, new Redactor());
          const snapshot = () => JSON.stringify({ tasks: store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), messages: store.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), ...(store.schemaVersion >= 5 ? { fts: store.db.prepare('SELECT rowid,* FROM messages_fts ORDER BY rowid').all() } : {}) });
          let before = snapshot(); const steps: Array<{ params: unknown; value: unknown; error: string | null; append?: { task: unknown; message: unknown } }> = [];
          const act = (params: Record<string, unknown>): { hits: SearchHit[]; nextCursor: SearchCursor | null } | null => {
            let value: { hits: SearchHit[]; nextCursor: SearchCursor | null } | null = null; let error: string | null = null;
            try { value = query.dispatch('workspace.search', params) as typeof value; } catch (cause) { error = (cause as Error).message; }
            steps.push({ params, value, error }); expect(snapshot()).toBe(before); return value;
          };
          for (const filter of filters) for (const limit of [1, 2, 50]) {
            let cursor: SearchCursor | null = null; const seen = new Set<string>();
            for (let n = 0; n < 100; n++) {
              const value = act({ query: 'alpha', ...filter, limit, ...(cursor ? { cursor } : {}) }); expect(value).not.toBeNull();
              for (const hit of value!.hits) { const key = hit.messageId ?? hit.taskId; expect(seen.has(key)).toBe(false); seen.add(key); }
              cursor = value!.nextCursor; if (!cursor) break; expect(n).toBeLessThan(99);
            }
          }
          for (const term of ['  alpha  ', 'ΟΣ', 'ος', 'İ', 'i\u0307', 'alpha beta', 'alpha\u0085beta', 'alpha\ufeffbeta', 'alpha\u2028beta', '"alpha"', 'one two three four five six seven eight nine', 'api_key', 'missing', '*', '\u0000']) act({ query: term, limit: 50 });
          const first = act({ query: 'alpha', limit: 1 }); expect(first?.nextCursor).not.toBeNull();
          act({ query: 'beta', limit: 1, cursor: first!.nextCursor });
          act({ query: 'alpha', limit: 2, cursor: { ...first!.nextCursor, taskThroughRowid: 0, throughOrdinal: 0 } });
          const lateTask = { ...tasks[0], id: id(51), title: 'Alpha late', createdAt: '2026-01-02T03:04:04.678Z' };
          const lateMessage = { ...messages[0], id: id(151), content: 'alpha late message' };
          store.saveTask(lateTask as Task); store.saveMessage(lateMessage as Message); before = snapshot();
          const retained = act({ query: 'alpha', limit: 50, cursor: first!.nextCursor });
          expect(retained?.hits.some(hit => hit.taskId === lateTask.id || hit.messageId === lateMessage.id)).toBe(false);
          steps.at(-1)!.append = { task: lateTask, message: lateMessage };
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { stamp, tasks, messages, cases };
    if (process.env.P2_WRITE_SEARCH === '1') writeFileSync('tests/p2/search-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/search-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
