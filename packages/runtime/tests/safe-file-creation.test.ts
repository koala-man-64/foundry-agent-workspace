import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsFileCreation } from '../src/safe-file-creation';
import * as jobs from '../src/windows-job';

const identity = '0123456789abcdef:0123456789abcdef0123456789abcdef';
const root = path.resolve('C:/isolated-fixture');
const bytes = Buffer.from("é\n'; throw 'not executable'\n", 'utf8');
const hash = createHash('sha256').update(bytes).digest('hex');
const creator = new WindowsFileCreation();
afterEach(() => { vi.restoreAllMocks(); });

function reply(stdout: unknown, changes: Record<string, unknown> = {}) {
  return vi.spyOn(jobs, 'runWindowsJob').mockImplementation(async (_helper, spec) => ({
    nonce: spec.nonce, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '',
    exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true, stdinDelivered: true, ...changes,
  }));
}

describe.runIf(process.platform === 'win32')('safe file bridge trust boundary', () => {
  it('keeps exact content and paths in bounded stdin data, never executable source', async () => {
    const job = reply({ version: 1, outcome: 'success', hash, error: '' });
    await creator.create(root, 'new.txt', [identity], bytes, hash);
    const spec = job.mock.calls[0]![1];
    const input = JSON.parse(Buffer.from(spec.stdinBytesBase64!, 'base64').toString('utf8'));
    expect(input).toMatchObject({ version: 1, operation: 'create', root, path: 'new.txt', identities: [identity], hash });
    expect(Buffer.from(input.contentBase64, 'base64')).toEqual(bytes);
    expect(spec.command).not.toContain(bytes.toString('utf8'));
    expect(spec.command).not.toContain(root);
    expect(input.source).toContain('class SafeFileCreation');
  });

  it.each(['none', 'unknown'] as const)('preserves a trusted %s primitive result', async outcome => {
    reply({ version: 1, outcome, hash: '', error: 'refused by primitive' });
    await expect(creator.create(root, 'new.txt', [identity], bytes, hash)).rejects.toMatchObject({ outcome, message: 'refused by primitive' });
  });

  it.each([
    { value: '{broken' },
    { value: { version: 1, outcome: 'success', hash: '0'.repeat(64), error: '' } },
    { value: { version: 1, outcome: 'success', hash, error: '', extra: true } },
    { value: { version: 1, outcome: 'success', hash, error: '' }, flags: { cleanupVerified: false } },
    { value: { version: 1, outcome: 'success', hash, error: '' }, flags: { cleanupVerified: 'true' } },
    { value: { version: 1, outcome: 'none', hash, error: 'inconsistent evidence' } },
    { value: { version: 1, outcome: 'success', hash, error: '' }, flags: { nonce: 'wrong' } },
    { value: { version: 1, outcome: 'none', hash: '', error: 'early' }, flags: { cancelled: true } },
  ])('keeps malformed, stale or unclean evidence unknown ($value)', async ({ value, flags }) => {
    reply(value, flags);
    await expect(creator.create(root, 'new.txt', [identity], bytes, hash)).rejects.toMatchObject({ outcome: 'unknown' });
  });

  it('keeps a lost reply unknown and a read-only inspection failure known-unstarted', async () => {
    vi.spyOn(jobs, 'runWindowsJob').mockRejectedValue(new Error('lost reply'));
    await expect(creator.create(root, 'new.txt', [identity], bytes, hash)).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(creator.inspect(root, 'new.txt')).rejects.toMatchObject({ outcome: 'none' });
  });

  it('accepts only lossless identity evidence from inspection', async () => {
    const job = reply({ version: 1, outcome: 'success', identities: [identity] });
    await expect(creator.inspect(root, 'new.txt')).resolves.toEqual([identity]);
    job.mockImplementationOnce(async (_helper, spec) => ({ nonce: spec.nonce, stdout: JSON.stringify({ version: 1, outcome: 'success', identities: [42] }), stderr: '', exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true, stdinDelivered: true }));
    await expect(creator.inspect(root, 'new.txt')).rejects.toMatchObject({ outcome: 'none' });
  });

  it('does not launch a cancelled or oversized request', async () => {
    const job = reply({ version: 1, outcome: 'success', hash, error: '' });
    await expect(creator.create(root, 'new.txt', [identity], bytes, hash, AbortSignal.abort())).rejects.toMatchObject({ outcome: 'none' });
    await expect(creator.inspect(root, 'x'.repeat(300_000))).rejects.toMatchObject({ outcome: 'none' });
    expect(job).not.toHaveBeenCalled();
  });

  it.each(['shell', 'helper', 'temp'])('classifies proven prelaunch setup failures as none: %s', async stage => {
    const job = reply({ version: 1, outcome: 'success', hash, error: '' });
    const failure = new Error('injected setup failure');
    if (stage === 'shell') vi.spyOn(fs, 'realpath').mockRejectedValueOnce(failure);
    else if (stage === 'helper') vi.spyOn(fs, 'realpath').mockResolvedValueOnce('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe').mockRejectedValueOnce(failure);
    else vi.spyOn(fs, 'mkdtemp').mockRejectedValueOnce(failure);
    await expect(creator.create(root, 'new.txt', [identity], bytes, hash)).rejects.toMatchObject({ outcome: 'none' });
    expect(job).not.toHaveBeenCalled();
  });
});
