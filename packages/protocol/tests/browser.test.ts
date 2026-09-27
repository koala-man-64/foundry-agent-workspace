import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrowserActionSchema, BrowserCommandSchema, BrowserHostCallSchema, BrowserHostReplySchema, BrowserUrlSchema } from '../src/browser';

describe('browser boundary schemas', () => {
  it('accepts HTTP development and HTTPS websites without embedded credentials', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1:1234', 'http://[::1]:3000/', 'https://example.test/path?q=a']) expect(BrowserUrlSchema.safeParse(url).success).toBe(true);
    for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,test', 'https://user:password@example.test', 'about:blank']) expect(BrowserUrlSchema.safeParse(url).success).toBe(false);
  });
  it('does not expose raw evaluation, storage or host commands through browser chrome', () => {
    for (const kind of ['evaluate', 'cookies', 'execute', 'snapshot', 'download', 'upload']) expect(BrowserCommandSchema.safeParse({ kind, tabId: randomUUID() }).success).toBe(false);
    expect(BrowserHostCallSchema.safeParse({ jsonrpc: '2.0', id: randomUUID(), method: 'browser.host', params: { kind: 'execute', taskId: randomUUID(), preparedId: randomUUID(), command: 'Runtime.evaluate' } }).success).toBe(false);
  });
  it('bounds interactions and requires snapshot references for element actions', () => {
    expect(BrowserActionSchema.safeParse({ kind: 'click', tabId: randomUUID(), nodeId: '1' }).success).toBe(false);
    expect(BrowserActionSchema.safeParse({ kind: 'fill', tabId: randomUUID(), snapshotId: randomUUID(), nodeId: '1', text: 'a'.repeat(4097) }).success).toBe(false);
    expect(() => z.toJSONSchema(BrowserActionSchema)).not.toThrow();
  });
  it('requires exactly one typed host result or error', () => {
    const reply = { jsonrpc: '2.0', id: randomUUID(), method: 'browser.host.result' };
    expect(BrowserHostReplySchema.safeParse(reply).success).toBe(false);
    expect(BrowserHostReplySchema.safeParse({ ...reply, result: null }).success).toBe(true);
    expect(BrowserHostReplySchema.safeParse({ ...reply, result: null, error: { code: 'unknown', message: 'Lost result' } }).success).toBe(false);
    expect(BrowserHostReplySchema.safeParse({ ...reply, result: { cookies: [] } }).success).toBe(false);
  });
});
