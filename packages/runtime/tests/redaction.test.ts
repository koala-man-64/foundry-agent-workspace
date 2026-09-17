import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/redaction';
describe('redaction', () => {
  it('screens exact registered credentials, common tokens and multiline private keys', () => {
    const redactor = new Redactor(); redactor.add('exact-canary-value');
    expect(redactor.text('exact-canary-value repeated exact-canary-value')).toBe('[REDACTED] repeated [REDACTED]');
    expect(redactor.text('api_key=abcdef123456')).not.toContain('abcdef');
    expect(redactor.text('-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----')).toBe('[REDACTED PRIVATE KEY]');
  });
});
