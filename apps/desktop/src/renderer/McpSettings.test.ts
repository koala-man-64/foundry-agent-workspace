import { describe, expect, it } from 'vitest';
import { MCP_KEY_PATTERN } from './McpSettings';

describe('MCP key pattern', () => {
  // Browsers compile pattern attributes with the `v` flag, which rejects an unescaped trailing hyphen in a class;
  // an invalid pattern is silently ignored, so it must compile under `v`.
  const key = new RegExp(`^(?:${MCP_KEY_PATTERN})$`, 'v');

  it('compiles under the v flag and accepts lowercase keys with hyphens', () => {
    for (const value of ['fixture', 'a', 'a-b', 'server-01', 'x'.repeat(32)]) expect(key.test(value)).toBe(true);
  });

  it('rejects uppercase, a leading hyphen, other characters and keys over 32 characters', () => {
    for (const value of ['Fixture', '-x', 'a_b', 'a b', '', 'x'.repeat(33)]) expect(key.test(value)).toBe(false);
  });
});
