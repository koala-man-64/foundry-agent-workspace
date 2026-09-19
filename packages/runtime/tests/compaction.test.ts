import { describe, expect, it } from 'vitest';
import type { ProviderContinuation } from '../../protocol/src/index';
import { applyCompactions, compactContinuation, continuationIssues, planMessageCompaction, summarizeMessages, MAX_SUMMARY_BYTES, type OrdinalMessage } from '../src/compaction';

const at = (index: number): string => new Date(Date.UTC(2026, 8, 17, 12, index)).toISOString();
const message = (ordinal: number, role: 'user' | 'assistant', content: string, status: OrdinalMessage['status'] = 'complete'): OrdinalMessage => ({ id: `m${ordinal}`, taskId: 't', role, content, createdAt: at(ordinal), status, ordinal });
const history = [message(1, 'user', 'first question'), message(2, 'assistant', 'first answer'), message(3, 'user', 'second question'), message(4, 'assistant', 'second answer'), message(5, 'user', 'third'), message(6, 'assistant', 'third answer', 'cancelled')];

describe('message compaction', () => {
  it('plans only older complete messages outside existing ranges and keeps recent ones verbatim', () => {
    const plan = planMessageCompaction(history, [], 2);
    expect(plan.messages.map(item => item.ordinal)).toEqual([1, 2, 3]);
    const record = { id: 'c1', taskId: 't', fromOrdinal: 1, toOrdinal: 3, messageIds: ['m1', 'm2', 'm3'], summary: 'S', estimatedTokensBefore: 10, estimatedTokensAfter: 5, createdAt: at(9) };
    expect(() => planMessageCompaction(history, [record], 2)).toThrow('Nothing to compact');
    expect(applyCompactions(history, [record])).toEqual([{ role: 'user', content: 'S' }, { role: 'assistant', content: 'second answer' }, { role: 'user', content: 'third' }]);
  });
  it('writes a bounded deterministic summary that names reviewed actions and stays labelled as data', () => {
    const summary = summarizeMessages(history.slice(0, 3), [{ tool: 'replace_text', state: 'complete', path: 'README.md', createdAt: at(2) }, { tool: 'run_command', state: 'rejected', createdAt: at(8) }]);
    expect(summary).toContain('runtime-generated');
    expect(summary).toContain('1. You: first question');
    expect(summary).toContain('replace_text README.md (complete)');
    expect(summary).not.toContain('run_command');
    const long = summarizeMessages(Array.from({ length: 400 }, (_, index) => message(index + 1, 'user', 'word '.repeat(200))));
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });
});

const responses = (): ProviderContinuation => ({ apiKind: 'responses', data: { input: [
  { role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'u1' }, { type: 'reasoning', id: 'r1', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
  { role: 'user', content: 'u2' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a2' }] },
  { role: 'user', content: 'u3' }, { type: 'reasoning', id: 'r3', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'c3', name: 'run_command', arguments: '{}' }
], calls: [{ id: 'c3', name: 'run_command', arguments: {} }] } });
const chat = (): ProviderContinuation => ({ apiKind: 'chat-completions', data: { messages: [
  { role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }, { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'u3' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'run_command', arguments: '{}' } }] }
], calls: [{ id: 'c3', name: 'run_command', arguments: {} }] } });
const anthropic = (): ProviderContinuation => ({ apiKind: 'anthropic', data: { system: 'SYSTEM', messages: [
  { role: 'user', content: 'u1' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }, { type: 'text', text: 'u2' }] }, { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
  { role: 'user', content: 'u3' }, { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
  { role: 'user', content: 'u4' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'c4', name: 'run_command', input: {} }] }
], calls: [{ id: 'c4', name: 'run_command', arguments: {} }] } });

describe('continuation compaction', () => {
  it('keeps system items, the summary, the recent turns and the pending tail for the Responses shape', () => {
    const result = compactContinuation(responses(), 'SUMMARY', 2);
    const input = (result.continuation.data as { input: Record<string, unknown>[] }).input;
    expect(input[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(input[1]).toEqual({ role: 'user', content: 'SUMMARY' });
    expect(input[2]).toEqual({ role: 'user', content: 'u2' });
    expect(input.some(item => item.call_id === 'c1')).toBe(false);
    expect(input.at(-1)).toMatchObject({ type: 'function_call', call_id: 'c3' });
    expect(input.some(item => item.id === 'r3')).toBe(true);
    expect(result.removedItems).toBe(5);
    expect(continuationIssues(result.continuation)).toEqual([]);
  });
  it('keeps assistant tool_calls with their tool results together for Chat Completions', () => {
    const result = compactContinuation(chat(), 'SUMMARY', 1);
    const messages = (result.continuation.data as { messages: Record<string, unknown>[] }).messages;
    expect(messages.map(item => item.role)).toEqual(['system', 'user', 'user', 'assistant']);
    expect(continuationIssues(result.continuation)).toEqual([]);
    expect(() => compactContinuation(chat(), 'SUMMARY', 3)).toThrow('Nothing to compact');
  });
  it('never cuts inside a tool-result user message for Anthropic and starts with a user turn', () => {
    const result = compactContinuation(anthropic(), 'SUMMARY', 2);
    const messages = (result.continuation.data as { messages: Record<string, unknown>[] }).messages;
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'SUMMARY' }] });
    expect(messages[1]).toEqual({ role: 'user', content: 'u3' });
    expect((result.continuation.data as { system: string }).system).toBe('SYSTEM');
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(continuationIssues(result.continuation)).toEqual([]);
    // With only the tool-result carrier as the second "user" message, the cut must move back to u1 and remove nothing.
    const short: ProviderContinuation = { apiKind: 'anthropic', data: { messages: (anthropic().data as { messages: unknown[] }).messages.slice(0, 4), calls: [] } };
    expect(() => compactContinuation(short, 'SUMMARY', 1)).toThrow('Nothing to compact');
  });
  it('fails visibly when the continuation is structurally invalid instead of persisting it', () => {
    const orphan: ProviderContinuation = { apiKind: 'responses', data: { input: [{ role: 'user', content: 'u1' }, { type: 'function_call_output', call_id: 'ghost', output: 'x' }], calls: [] } };
    expect(continuationIssues(orphan)).toEqual(expect.arrayContaining([expect.stringContaining('ghost')]));
    expect(() => compactContinuation(orphan, 'S', 1)).toThrow('failed provider continuation validation');
    const missingPending: ProviderContinuation = { apiKind: 'chat-completions', data: { messages: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a' }], calls: [{ id: 'c9', name: 'x', arguments: {} }] } };
    expect(continuationIssues(missingPending)).toEqual(expect.arrayContaining([expect.stringContaining('c9')]));
    expect(continuationIssues({ apiKind: 'anthropic', data: { messages: 'nope' } })).toEqual([expect.stringContaining('schema')]);
    expect(compactContinuation({ apiKind: 'fake', data: { stage: 'chat', calls: [] } }, 'S').removedItems).toBe(0);
  });
});
