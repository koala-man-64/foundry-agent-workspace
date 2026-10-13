import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import type { Task, Message } from '../../packages/protocol/src/index';

const timestamp = '2026-01-02T03:04:05.678Z';
const root = '11111111-0000-4000-8000-000000000001';
const child = '11111111-0000-4000-8000-000000000002';
const user = '11111111-0000-4000-8000-000000000003';
const assistant = '11111111-0000-4000-8000-000000000004';
type Operation = { name: string; kind: string; value: Record<string, unknown>; transition?: { reason?: string; usageKnown?: boolean; chargedTokens?: number }; omitArchive?: boolean };
const operations: Operation[] = [
  { name: 'new-root', kind: 'task', value: { id: root, title: 'Root', workspaceKind: 'none', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: timestamp, updatedAt: timestamp, tokenBudget: 4096, usedTokens: 0, mode: 'chat', future: { opaque: [1, null, 'keep'] } } },
  { name: 'same-task', kind: 'patch', value: {} },
  { name: 'accounting-only', kind: 'patch', value: { tokenBudget: 8192, usedTokens: 7, projectId: '11111111-0000-4000-8000-000000000099' } },
  { name: 'title', kind: 'patch', value: { title: 'Renamed' } },
  { name: 'running', kind: 'patch', value: { status: 'running' } },
  { name: 'completed', kind: 'patch', value: { status: 'idle' }, transition: { usageKnown: false, chargedTokens: 7 } },
  { name: 'failed', kind: 'patch', value: { status: 'failed' }, transition: { reason: 'fixture failure', usageKnown: true, chargedTokens: 0 } },
  { name: 'cancelled', kind: 'patch', value: { status: 'cancelled' } },
  { name: 'interrupted', kind: 'patch', value: { status: 'interrupted' } },
  { name: 'archived', kind: 'patch', value: { archivedAt: timestamp } },
  { name: 'archive-omitted-retains-column', kind: 'patch', value: {}, omitArchive: true },
  { name: 'unarchived-null', kind: 'patch', value: { archivedAt: null } },
  { name: 'unarchived-null-again', kind: 'patch', value: { archivedAt: null } },
  { name: 'unarchived-empty', kind: 'patch', value: { archivedAt: '' } },
  { name: 'retired', kind: 'patch', value: { status: 'retired' } },
  { name: 'new-child', kind: 'task', value: { id: child, title: 'Child', workspaceKind: 'folder', projectPath: 'C:\\fixture\\folder', parentTaskId: root, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: timestamp, updatedAt: timestamp, tokenBudget: 4096, usedTokens: 0, mode: 'chat' } },
  { name: 'user-complete', kind: 'message', value: { id: user, taskId: root, role: 'user', content: 'api_key=fixture-secret-value', createdAt: timestamp, status: 'complete', future: { keep: true } } },
  { name: 'assistant-streaming', kind: 'message', value: { id: assistant, taskId: child, role: 'assistant', content: 'partial 😀', createdAt: timestamp, status: 'streaming' } },
  { name: 'assistant-update', kind: 'message', value: { id: assistant, taskId: child, role: 'assistant', content: 'finished 😀', createdAt: timestamp, status: 'complete', opaque: [null, 3] } },
  { name: 'assistant-same-complete', kind: 'message', value: { id: assistant, taskId: child, role: 'assistant', content: 'finished 😀', createdAt: timestamp, status: 'complete', opaque: [null, 3] } },
  { name: 'assistant-failed', kind: 'message', value: { id: assistant, taskId: child, role: 'assistant', content: 'retained partial', createdAt: timestamp, status: 'failed' } },
  { name: 'assistant-completed-again', kind: 'message', value: { id: assistant, taskId: child, role: 'assistant', content: 'retained completion', createdAt: timestamp, status: 'complete' } }
];

it('pins task/message rows, projections and lifecycle events for every disposable era', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-task-store-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db')))
          copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          const schema = Number(store.db.pragma('user_version', { simple: true }));
          const steps = operations.map(operation => {
            let value: unknown;
            if (operation.kind === 'message') { store.saveMessage(operation.value as unknown as Message); value = null; }
            else {
              const task = operation.kind === 'patch' ? { ...store.task(root), ...operation.value } : { ...operation.value };
              if (operation.omitArchive) delete (task as Record<string, unknown>).archivedAt;
              value = store.saveTask(task as Task, operation.transition);
            }
            return { operation, expected: { value,
              tasks: store.db.prepare("SELECT rowid AS _rowid,* FROM tasks WHERE id LIKE '11111111-%' ORDER BY rowid").all(),
              messages: store.db.prepare("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '11111111-%' ORDER BY rowid").all(),
              events: store.db.prepare("SELECT * FROM events WHERE task_id LIKE '11111111-%' ORDER BY sequence").all(),
              fts: schema >= 5 ? store.db.prepare("SELECT rowid AS _rowid,* FROM messages_fts WHERE message_id LIKE '11111111-%' ORDER BY rowid").all() : [],
              generations: schema >= 5 ? store.db.prepare('SELECT * FROM workspace_read_meta').all() : []
            } };
          });
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    if (process.env.P2_WRITE_TASKS === '1') writeFileSync('tests/p2/task-store-vectors.json', JSON.stringify(cases, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/task-store-vectors.json', 'utf8'))).toEqual(cases);
  } finally { vi.useRealTimers(); }
});
