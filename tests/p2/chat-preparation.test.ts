import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { prepareRequest } from '../../packages/runtime/src/agent-loop';
import { hasBlockingUnknown } from '../../packages/runtime/src/browser-tools';
import type { Message, ModelProfile, Task } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

const timestamp = '2026-01-02T03:04:05.678Z';
const task = { id: '66666666-0000-4000-8000-000000000001', title: 'Preparation', workspaceKind: 'none', mode: 'chat', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: timestamp, updatedAt: timestamp, tokenBudget: 4096, usedTokens: 0 } as Task;
const profile = { id: FAKE_PROFILE_ID, name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'deterministic-fixture', contextLimit: 32000, outputLimit: 2048 } as ModelProfile;
const messages = [{ id: '66666666-0000-4000-8000-000000000002', taskId: task.id, role: 'user', content: 'retained 😀', status: 'complete', createdAt: timestamp }, { id: '66666666-0000-4000-8000-000000000003', taskId: task.id, role: 'assistant', content: 'partial must not be sent', status: 'interrupted', createdAt: timestamp }];
const native = { fingerprint: 'fixture', continuation: { apiKind: 'fake', data: { stage: 'chat', opaque: ['\ud800', { future: true }], calls: [] } }, pending: [{ id: 'kept', name: 'read_file', arguments: { path: 'untrusted' } }, { id: 'lost', name: 'run_command', arguments: { command: 'never replay' } }], results: [{ id: 'kept', name: 'read_file', content: 'retained result', isError: false, future: 1 }], future: true };
const states = [null, { ...native, fingerprint: 'earlier' }, native, { ...native, pending: [], results: [] }];
const approvals = [null, { sql: 'unknown', data: { taskId: task.id, state: 'complete' } }, { sql: 'complete', data: { taskId: task.id, state: 'unknown' } }, { sql: 'unknown', data: { taskId: 'other', state: 'unknown' } },
  ...[null, false, true, {}, '', 'acknowledged', 0, 1].map(acknowledgment => ({ sql: 'unknown', data: { taskId: task.id, state: 'unknown', browser: { acknowledgment } } }))];

it('pins ordinary chat preparation gates and pending results without replay on disposable eras', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-chat-preparation-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db')))
          copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          store.saveTask(task); for (const message of messages) store.saveMessage(message as Message);
          const steps = [false, true].flatMap(omitMode => states.flatMap(state => approvals.map(approval => {
            const current = { ...task }; if (omitMode) delete current.mode; store.saveTask(current);
            store.db.prepare("DELETE FROM intents WHERE id IN (?,?)").run(task.id, 'preparation-approval');
            if (state) store.db.prepare("INSERT INTO intents VALUES(?,'provider.context',?,'complete')").run(task.id, JSON.stringify(state));
            if (approval) store.db.prepare("INSERT INTO intents VALUES(?,'tool.approval',?,?)").run('preparation-approval', JSON.stringify(approval.data), approval.sql);
            const before = store.db.prepare('SELECT * FROM intents ORDER BY rowid').all();
            let value: unknown = null; let error: string | null = null;
            try { const prepared = prepareRequest(store, current, profile, 'fixture', 'new 😀', undefined, new AbortController().signal); const { signal: _signal, credential: _credential, ...wire } = prepared; value = wire; } catch (cause) { error = (cause as Error).message; }
            expect(store.db.prepare('SELECT * FROM intents ORDER BY rowid').all()).toEqual(before);
            return { omitMode, state, approval, expected: { value, error, blockingUnknown: hasBlockingUnknown(store, task.id) } };
          })));
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { task, profile, messages, cases };
    if (regenerating('P2_WRITE_PREPARATION')) writeFileSync('tests/p2/chat-preparation-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/chat-preparation-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
