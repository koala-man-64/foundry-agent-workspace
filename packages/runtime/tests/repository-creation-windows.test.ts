import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryService } from '../src/repository';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-real-create-')); roots.push(root);
  await fs.mkdir(path.join(root, 'src'));
  return { root, service: new RepositoryService(path.join(root, 'unused')) };
}

describe.runIf(process.platform === 'win32')('shipping Windows new-file primitive bridge', () => {
  it.each([{ name: 'empty file', content: '' }, { name: '64 KiB UTF-8', content: 'é'.repeat(32768) }])('creates and verifies exact bytes: $name', async ({ content }) => {
    const { root, service } = await fixture();
    const edit = await service.prepareEdit(root, 'src/new.txt', null, content);
    expect(edit.creationIdentities?.length).toBeGreaterThan(1);
    await expect(fs.access(path.join(root, 'src', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.applyEdit(edit)).resolves.toEqual({ path: 'src/new.txt', hash: edit.resultingHash });
    expect(await fs.readFile(path.join(root, 'src', 'new.txt'))).toEqual(Buffer.from(content, 'utf8'));
  }, 90_000);

  it('refuses a competing entry and a replaced parent without overwriting or creating outside', async () => {
    const { root, service } = await fixture();
    const edit = await service.prepareEdit(root, 'src/new.txt', null, 'reviewed');
    await fs.writeFile(path.join(root, 'src', 'new.txt'), 'competing');
    await expect(service.applyEdit(edit)).rejects.toMatchObject({ outcome: 'none' });
    expect(await fs.readFile(path.join(root, 'src', 'new.txt'), 'utf8')).toBe('competing');
    await fs.unlink(path.join(root, 'src', 'new.txt'));
    await fs.rename(path.join(root, 'src'), path.join(root, 'original-src'));
    await fs.mkdir(path.join(root, 'src'));
    await expect(service.applyEdit(edit)).rejects.toMatchObject({ outcome: 'none' });
    await expect(fs.access(path.join(root, 'src', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(root, 'original-src', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 90_000);
});
