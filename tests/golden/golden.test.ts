import { describe, expect, it } from 'vitest';
import { jsJsonVectors, manifestVectors, mcpConfigVectors, profileFingerprintVectors, redactionVectors, scheduleVectors } from './vectors';
import { rpcCorpus, wireCases } from './rpc-corpus';
import { golden } from './golden-file';

describe('golden vectors for the WPF migration', () => {
  it('pins JSON.stringify output and hashes', () => golden('jsjson', jsJsonVectors()));
  it('pins both profile fingerprint variants', () => golden('profile-fingerprint', profileFingerprintVectors()));
  it('pins handoff manifest ordering and hashes', () => golden('manifest', manifestVectors()));
  it('pins schedule wall-clock resolution', () => golden('schedules', scheduleVectors()));
  it('pins redaction output', () => golden('redaction', redactionVectors()));
  it('pins MCP configuration admission', () => golden('mcp-config', mcpConfigVectors()));
  it('seeds every protocol schema and pins zod verdicts', () => {
    const { entries, unseeded } = rpcCorpus();
    expect(unseeded).toEqual([]);
    golden('rpc-corpus', entries);
  });
  it('pins wire-level parser cases', () => golden('rpc-wire', wireCases()));
});
