import { safeStorage } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export class CredentialVault {
  constructor(private readonly directory: string) {}
  private path(id: string): string { return join(this.directory, `${z.string().uuid().parse(id)}.bin`); }
  async save(id: string, value: string, binding: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS-backed credential encryption is unavailable.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(id); const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, safeStorage.encryptString(JSON.stringify({ value, binding })), { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  }
  async load(id: string, binding: string): Promise<string | undefined> {
    try {
      const record = z.object({ value: z.string(), binding: z.string() }).parse(JSON.parse(safeStorage.decryptString(await readFile(this.path(id)))));
      if (record.binding !== binding) throw new Error('Credential binding changed.');
      return record.value;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Could not unlock a saved credential for this endpoint. Re-enter it in model settings.', { cause: error }); }
  }
}
