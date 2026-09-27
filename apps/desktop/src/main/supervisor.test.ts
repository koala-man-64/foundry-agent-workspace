import { describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSupervisor } from './supervisor';

describe('runtime supervisor transport failures', () => {
  it('ignores a stale browser invalidation write failure after transport replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'foundry-supervisor-browser-'));
    const runtimePath = join(directory, 'passive-runtime.cjs');
    writeFileSync(runtimePath, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    let exits = 0;
    const supervisor = new RuntimeSupervisor(runtimePath, directory, () => undefined, () => { exits++; });
    const state = supervisor as unknown as { child: ChildProcessWithoutNullStreams; pending: Map<string, unknown> };
    try {
      supervisor.start();
      const oldChild = state.child;
      let callback: ((error?: Error | null) => void) | undefined;
      vi.spyOn(oldChild.stdin, 'write').mockImplementation((...args: unknown[]) => { callback = args.at(-1) as typeof callback; return true; });
      supervisor.invalidateBrowser('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
      const oldExit = new Promise<void>(resolve => oldChild.once('exit', () => resolve()));
      oldChild.stdout.emit('error', new Error('transport stopped'));
      await oldExit;
      supervisor.start();
      const current = state.child;
      const request = supervisor.request('task.read', {});
      callback!(new Error('late old write failure'));
      expect(exits).toBe(1);
      expect(state.pending.size).toBe(1);
      expect(state.child).toBe(current);
      const currentExit = new Promise<void>(resolve => current.once('exit', () => resolve()));
      current.stdout.emit('error', new Error('fixture cleanup'));
      await expect(request).rejects.toThrow(/outcome may be unknown/i);
      await currentExit;
    } finally { await supervisor.stop(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(['stdin', 'stdout', 'stderr'] as const)('fails closed on %s pipe error during a request', async streamName => {
    const directory = mkdtempSync(join(tmpdir(), 'foundry-supervisor-pipe-'));
    const runtimePath = join(directory, 'passive-runtime.cjs');
    writeFileSync(runtimePath, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    let exits = 0;
    const supervisor = new RuntimeSupervisor(runtimePath, directory, () => undefined, () => { exits++; });
    try {
      supervisor.start();
      const child = (supervisor as unknown as { child?: ChildProcessWithoutNullStreams }).child;
      expect(child).toBeDefined();
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      const inFlight = supervisor.request('task.send', { taskId: 'fixture', content: 'may have reached runtime' });
      const anotherInFlight = supervisor.request('task.read', { taskId: 'fixture' });
      child![streamName].emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
      await expect(inFlight).rejects.toThrow(/outcome may be unknown/i);
      await expect(anotherInFlight).rejects.toThrow(/outcome may be unknown/i);
      await exited;
      expect(exits).toBe(1);
      await expect(supervisor.request('task.send', {})).rejects.toThrow(/not available/i);
    } finally {
      await supervisor.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
