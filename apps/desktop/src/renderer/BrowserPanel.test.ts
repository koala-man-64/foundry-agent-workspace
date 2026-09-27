import { describe, expect, it } from 'vitest';
import { normalizeBrowserAddress } from './BrowserPanel';

describe('browser address entry', () => {
  it('defaults public hosts to HTTPS and local development hosts to HTTP', () => {
    expect(normalizeBrowserAddress('example.com/path')).toBe('https://example.com/path');
    expect(normalizeBrowserAddress('example.com:8443/path')).toBe('https://example.com:8443/path');
    expect(normalizeBrowserAddress('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserAddress('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
    expect(normalizeBrowserAddress('[::1]:8080')).toBe('http://[::1]:8080/');
    expect(normalizeBrowserAddress('http://localhost:3000/test')).toBe('http://localhost:3000/test');
  });

  it('rejects privileged schemes and embedded credentials', () => {
    expect(() => normalizeBrowserAddress('file:///C:/private.txt')).toThrow();
    expect(() => normalizeBrowserAddress('javascript:alert(1)')).toThrow();
    expect(() => normalizeBrowserAddress('https://user:secret@example.com')).toThrow();
  });
});
