import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryService } from '../src/repository';
import { FileCreationError, type FileCreation } from '../src/safe-file-creation';

const directories: string[] = [];
const identity = '0123456789abcdef:0123456789abcdef0123456789abcdef';
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-create-binding-'));
  directories.push(root);
  const creation: FileCreation = { inspect: vi.fn(async () => [identity]), create: vi.fn(async () => {}) };
  return { root, creation, service: new RepositoryService(path.join(root, 'unused-worktree-base'), creation) };
}

describe('new-file review binding', () => {
  it('binds the observed parent identities and exact UTF-8 hash into the review', async () => {
    const { root, creation, service } = await fixture();
    const edit = await service.prepareEdit(root, 'new.txt', null, 'é\n');
    expect(edit).toMatchObject({ path: 'new.txt', before: '', after: 'é\n', expectedHash: null, creationIdentities: [identity] });
    expect(edit.fingerprint).toBe(createHash('sha256').update(JSON.stringify([edit.root, edit.path, null, edit.resultingHash, [identity]])).digest('hex'));
    await service.applyEdit(edit);
    expect(creation.create).toHaveBeenCalledWith(edit.root, 'new.txt', [identity], Buffer.from('é\n', 'utf8'), edit.resultingHash, undefined);
  });

  it('refuses a replaced parent before invoking any creation', async () => {
    const { root, creation, service } = await fixture();
    const edit = await service.prepareEdit(root, 'new.txt', null, 'x');
    vi.mocked(creation.inspect).mockResolvedValue(['f'.repeat(16) + ':' + 'f'.repeat(32)]);
    await expect(service.applyEdit(edit)).rejects.toMatchObject({ outcome: 'none', mutationStarted: false });
    expect(creation.create).not.toHaveBeenCalled();
  });

  it('refuses changed content and cancelled work before creation', async () => {
    const { root, creation, service } = await fixture();
    const edit = await service.prepareEdit(root, 'new.txt', null, 'x');
    await expect(service.applyEdit({ ...edit, after: 'different' })).rejects.toMatchObject({ outcome: 'none' });
    await expect(service.applyEdit(edit, AbortSignal.abort())).rejects.toMatchObject({ outcome: 'none' });
    expect(creation.create).not.toHaveBeenCalled();
  });

  it.each(['none', 'unknown'] as const)('preserves the primitive %s outcome', async outcome => {
    const { root, creation, service } = await fixture();
    const edit = await service.prepareEdit(root, 'new.txt', null, '');
    vi.mocked(creation.create).mockRejectedValue(new FileCreationError('injected boundary failure', outcome));
    await expect(service.applyEdit(edit)).rejects.toMatchObject({ outcome, mutationStarted: outcome === 'unknown' });
  });

  it('keeps an unclassified post-dispatch exception unknown', async () => {
    const { root, creation, service } = await fixture();
    const edit = await service.prepareEdit(root, 'new.txt', null, '');
    vi.mocked(creation.create).mockRejectedValue(new Error('lost bridge result'));
    await expect(service.applyEdit(edit)).rejects.toMatchObject({ outcome: 'unknown', mutationStarted: true });
  });

  it.each(['.env', '.git/config', 'credentials.json', 'nul.txt', 'x:stream', '../outside.txt', 'file.'])('refuses protected or ambiguous path %s before inspection', async relative => {
    const { root, creation, service } = await fixture();
    await expect(service.prepareEdit(root, relative, null, 'x')).rejects.toThrow();
    expect(creation.inspect).not.toHaveBeenCalled();
    expect(creation.create).not.toHaveBeenCalled();
  });

  it('never creates a missing parent directory or accepts oversized UTF-8/NUL input', async () => {
    const { root, creation, service } = await fixture();
    await expect(service.prepareEdit(root, 'missing/new.txt', null, 'x')).rejects.toThrow();
    await expect(service.prepareEdit(root, 'new.txt', null, 'é'.repeat(32769))).rejects.toThrow(/64 KB/);
    await expect(service.prepareEdit(root, 'new.txt', null, 'x\0y')).rejects.toThrow(/64 KB/);
    await expect(fs.access(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(creation.inspect).not.toHaveBeenCalled();
  });
});
