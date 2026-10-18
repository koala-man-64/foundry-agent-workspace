import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store } from '../../packages/runtime/src/store';
import { Redactor } from '../../packages/runtime/src/redaction';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import type { Message, Task } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

const timestamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `33333333-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const tasks = [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: id(n), title: `History ${n}`, workspaceKind: 'none', mode: 'chat', profileId: '00000000-0000-4000-8000-000000000001', status: 'idle', createdAt: timestamp, updatedAt: timestamp, tokenBudget: 4096, usedTokens: 0 }));
const messages = [
  { id: id(11), taskId: id(1), role: 'user', content: 'plain', status: 'complete' },
  { id: id(12), taskId: id(1), role: 'assistant', content: 'api_key=fixture-secret-value hidden-fixture-secret', status: 'failed', future: { keep: true } },
  { id: id(13), taskId: id(1), role: 'user', content: 'a'.repeat(4095) + '😀z', status: 'complete' },
  { id: id(14), taskId: id(1), role: 'assistant', content: 'A😀éB', status: 'streaming' },
  { id: id(15), taskId: id(1), role: 'user', content: '\u0000'.repeat(65536), status: 'complete' },
  { id: id(16), taskId: id(1), role: 'assistant', content: '', status: 'complete', truncated: false },
  { id: id(17), taskId: id(1), role: 'user', content: 'lone \ud800 and \udfff', status: 'complete' },
  { id: id(18), taskId: id(2), role: 'user', content: 'other-task-private', status: 'complete' },
  { id: id(19), taskId: id(3), role: 'user', content: 'oversize metadata', status: 'complete', opaque: 'x'.repeat(256 * 1024) },
  ...[21, 22, 23].map(n => ({ id: id(n), taskId: id(5), role: 'user', content: 'partial-page metadata', status: 'complete', opaque: 'x'.repeat(100 * 1024) })),
  ...[24, 25].map(n => ({ id: id(n), taskId: id(n - 18), role: 'user', content: 'exact boundary', status: 'complete', opaque: '' }))
].map(message => ({ ...message, createdAt: timestamp }));

type Query = { method: 'task.messages' | 'task.messageContent'; params: Record<string, unknown> };
it('pins bounded redacted history and UTF8 chunks without rewriting retained documents', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-messages-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db')))
          copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          for (const task of tasks) store.saveTask(task as Task);
          for (const message of messages) store.saveMessage(message as Message);
          const sizingPatches: Array<{ messageId: string; opaqueLength: number }> = [];
          if (era === 'fresh') for (const n of [24, 25]) {
            const original = messages.find(message => message.id === id(n))!;
            const ordinal = (store.db.prepare('SELECT ordinal FROM messages WHERE id=?').get(id(n)) as { ordinal: number }).ordinal;
            const opaqueLength = 256 * 1024 - 1024 - Buffer.byteLength(JSON.stringify({ items: [{ message: original, ordinal }] }), 'utf8') + (n === 25 ? 1 : 0);
            store.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify({ ...original, opaque: 'x'.repeat(opaqueLength) }), id(n));
            sizingPatches.push({ messageId: id(n), opaqueLength });
          }
          const beforeRows = store.db.prepare("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '33333333-%' ORDER BY rowid").all();
          const last = (store.db.prepare('SELECT MAX(ordinal) AS n FROM messages WHERE task_id=?').get(id(1)) as { n: number }).n;
          const queries: Query[] = [
            { method: 'task.messages', params: { taskId: id(1), limit: 2 } },
            { method: 'task.messages', params: { taskId: id(1), limit: 50, through: last - 2 } },
            { method: 'task.messages', params: { taskId: id(1), limit: 2, before: last - 2, through: last - 1 } },
            { method: 'task.messages', params: { taskId: id(4) } },
            { method: 'task.messages', params: { taskId: id(99) } },
            { method: 'task.messages', params: { taskId: id(3) } },
            { method: 'task.messageContent', params: { taskId: id(1), messageId: id(12) } },
            { method: 'task.messageContent', params: { taskId: id(1), messageId: id(18) } },
            { method: 'task.messageContent', params: { taskId: id(99), messageId: id(14) } },
            { method: 'task.messageContent', params: { taskId: id(1), messageId: id(16) } },
            { method: 'task.messageContent', params: { taskId: id(1), messageId: id(17) } }
          ];
          if (era === 'fresh') {
            for (const before of [0, 1, last, last + 1, Number.MAX_SAFE_INTEGER]) queries.push({ method: 'task.messages', params: { taskId: id(1), before, through: Number.MAX_SAFE_INTEGER, limit: 1 } });
            for (const offset of [0, 1, 2, 4, 5, 6, 7, 8, 9]) for (const maxBytes of [1, 4])
              queries.push({ method: 'task.messageContent', params: { taskId: id(1), messageId: id(14), offset, maxBytes } });
            queries.push({ method: 'task.messageContent', params: { taskId: id(1), messageId: id(15), maxBytes: 65536 } });
            queries.push({ method: 'task.messageContent', params: { taskId: id(1), messageId: id(13), offset: 4095, maxBytes: 1 } });
            const partialMax = (store.db.prepare('SELECT MAX(ordinal) AS n FROM messages WHERE task_id=?').get(id(5)) as { n: number }).n;
            queries.push({ method: 'task.messages', params: { taskId: id(5) } });
            queries.push({ method: 'task.messages', params: { taskId: id(5), before: partialMax - 1 } });
            queries.push({ method: 'task.messages', params: { taskId: id(6) } });
            queries.push({ method: 'task.messages', params: { taskId: id(7) } });
          }
          const redactor = new Redactor(); redactor.add('hidden-fixture-secret');
          const reader = new WorkspaceQueries(store, redactor);
          const steps = queries.map(query => {
            let value: unknown = null; let error: string | null = null;
            try { value = reader.dispatch(query.method, query.params); } catch (cause) { error = (cause as Error).message; }
            return { query, expected: { value, error } };
          });
          expect(store.db.prepare("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '33333333-%' ORDER BY rowid").all()).toEqual(beforeRows);
          return { era, sizingPatches, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { tasks, messages, secret: 'hidden-fixture-secret', cases };
    if (regenerating('P2_WRITE_MESSAGES')) writeFileSync('tests/p2/message-query-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/message-query-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
