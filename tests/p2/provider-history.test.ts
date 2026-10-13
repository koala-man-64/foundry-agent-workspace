import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID, type ProviderState } from '../../packages/runtime/src/store';
import { applyCompactions, type OrdinalMessage } from '../../packages/runtime/src/compaction';
import type { CompactionRecord, Message, Task } from '../../packages/protocol/src/index';

const timestamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = { id: id(1), title: 'History', workspaceKind: 'none', mode: 'chat', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: timestamp, updatedAt: timestamp, tokenBudget: 4096, usedTokens: 0 } as Task;
const messages = [
  { id: id(2), taskId: task.id, role: 'user', content: 'retained user 😀', createdAt: timestamp, status: 'complete', ordinal: 999, future: { untouched: true } },
  { id: id(3), taskId: task.id, role: 'assistant', content: 'retained partial', createdAt: timestamp, status: 'interrupted' },
  { id: id(4), taskId: task.id, role: 'assistant', content: 'retained answer', createdAt: timestamp, status: 'complete' }
];
const state = { fingerprint: 'fixture-fingerprint', continuation: { apiKind: 'fake', data: { opaque: ['raw\ud800', null, { future: true }], calls: [] } }, pending: [], results: [], future: { preserved: true } };
const range = (rangeId: string, fromOrdinal: number, toOrdinal: number, summary = `summary ${rangeId} 😀`) => ({ id: rangeId, fromOrdinal, toOrdinal, summary });

it('pins complete-message compaction transform including ordering, overlap and duplicate identities', () => {
  const base = ['system', 'user', 'assistant', 'tool', 'user', 'assistant'].map((role, index) => ({ role, content: `message ${index + 1} 😀`, ordinal: index + 1, status: 'complete' }));
  const inputs = [
    [], base, base.map(message => ({ ...message, status: 'streaming' })),
    ...base.map((_, index) => base.map((message, current) => ({ ...message, ...(current === index ? { status: 'interrupted' } : {}) }))),
    base.map(message => ({ ...message, role: 'user', content: '' })),
    [base[5], ...base.slice(0, 5)],
    [{ status: 'failed' }, { role: 'user', content: 'no status', ordinal: 9 }]
  ];
  const ranges = [[], [range('a', 2, 4)], [range('a', 1, 6)], [range('a', 9, 12)], [range('a', 4, 2)],
    [range('a', 2, 3), range('b', 5, 6)], [range('b', 5, 6), range('a', 2, 3)],
    [range('a', 2, 4), range('b', 2, 6)], [range('b', 2, 6), range('a', 2, 4)],
    [range('same', 1, 2), range('same', 5, 6)], [range('A', 1, 2), range('a', 5, 6)], [range('empty', 2, 4, '')]];
  const cases = inputs.flatMap(input => ranges.map(compactions => ({ messages: input, compactions, expected: applyCompactions(input as unknown as OrdinalMessage[], compactions as CompactionRecord[]) })));
  if (process.env.P2_WRITE_HISTORY === '1') writeFileSync('tests/p2/provider-history-vectors.json', JSON.stringify(cases, null, 2) + '\n');
  expect(JSON.parse(readFileSync('tests/p2/provider-history-vectors.json', 'utf8'))).toEqual(cases);
});

it('pins raw retained messages, compaction projections and opaque provider-state reads on disposable eras', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-retained-history-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db')))
          copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          store.saveTask(task); for (const message of messages) store.saveMessage(message as Message);
          const history = store.messagesWithOrdinals(task.id);
          const compaction = { id: id(5), taskId: task.id, fromOrdinal: history[1]!.ordinal, toOrdinal: history[2]!.ordinal, messageIds: [id(3), id(4)], summary: 'retained summary 😀', estimatedTokensBefore: 300, estimatedTokensAfter: 20, createdAt: timestamp };
          store.saveCompaction(compaction, undefined, state as ProviderState); store.saveProviderState(task.id, state as ProviderState);
          const before = store.db.prepare('SELECT data FROM intents WHERE id=?').get(task.id);
          const expected = { messages: store.messagesWithOrdinals(task.id), compactions: store.compactions(task.id), state: store.providerState(task.id),
            emptyMessages: store.messagesWithOrdinals(id(99)), emptyCompactions: store.compactions(id(99)), missingState: store.providerState(id(99)) ?? null,
            providerHistory: applyCompactions(store.messagesWithOrdinals(task.id), store.compactions(task.id)) };
          expect(store.db.prepare('SELECT data FROM intents WHERE id=?').get(task.id)).toEqual(before);
          return { era, compaction, expected };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { task, messages, state, cases };
    if (process.env.P2_WRITE_HISTORY === '1') writeFileSync('tests/p2/retained-history-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/retained-history-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
