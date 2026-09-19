import { describe, expect, it } from 'vitest';
import { assertAcyclic, covers, inScope, normalizeScope, normalizeScopePath, ordered, scopesOverlap } from '../src/scope';

describe('assignment scope policy', () => {
  it('normalizes segment-aware portable paths and rejects traversal, absolute, Git and secret paths', () => {
    expect(normalizeScopePath('src\\feature\\', false)).toBe('src/feature');
    expect(normalizeScopePath('', true)).toBe('');
    for (const bad of ['', '../x', 'a/../b', '/abs', 'C:/x', 'C:x', '.git/config', 'src/.GIT/x', '.gitmodules', 'config/.env', 'keys/id_rsa', 'cert.pem', 'a:stream', 'trailing.', 'CON', 'nul.txt', 'a//b', './a']) {
      expect(() => normalizeScopePath(bad, false), bad).toThrow();
    }
    expect(() => normalizeScope(['src', 'SRC'], false)).toThrow('differ only by case');
  });
  it('matches by whole segments with Windows case handling', () => {
    expect(covers('src', 'src/a.ts')).toBe(true);
    expect(covers('src', 'SRC/A.ts')).toBe(true);
    expect(covers('src', 'src2/a.ts')).toBe(false);
    expect(covers('src/a.ts', 'src/a.ts.bak')).toBe(false);
    expect(inScope(['docs'], 'docs/../secrets.txt')).toBe(false);
    expect(inScope(['docs'], 'docs/.env')).toBe(false);
    expect(inScope(['docs'], 'docs/guide.md')).toBe(true);
  });
  it('detects overlapping write scopes in either direction', () => {
    expect(scopesOverlap(['src'], ['src/a.ts'])).toBe(true);
    expect(scopesOverlap(['src/a.ts'], ['SRC'])).toBe(true);
    expect(scopesOverlap(['src/a'], ['src/ab'])).toBe(false);
  });
  it('rejects cycles and unknown nodes and recognizes serial ordering', () => {
    expect(() => assertAcyclic(new Map([['a', ['b']], ['b', ['a']]]))).toThrow('cycle');
    expect(() => assertAcyclic(new Map([['a', ['missing']]]))).toThrow('unknown');
    const edges = new Map([['a', []], ['b', ['a']], ['c', ['b']], ['d', []]]);
    expect(() => assertAcyclic(edges)).not.toThrow();
    expect(ordered(edges, 'c', 'a')).toBe(true);
    expect(ordered(edges, 'a', 'c')).toBe(true);
    expect(ordered(edges, 'd', 'a')).toBe(false);
  });
});
