/**
 * Waiting for a user decision never occupies an execution slot. An optional key applies an
 * additional per-profile limit so one model profile cannot hold every shared slot.
 */
export class ExecutionSlots {
  private active = 0;
  private readonly perKey = new Map<string, number>();
  private readonly wake = new Set<() => void>();
  constructor(private readonly limit = 3, private readonly keyLimit = 2) {}
  async use<T>(signal: AbortSignal, action: () => Promise<T>, key?: string): Promise<T> {
    while (this.active >= this.limit || (key !== undefined && (this.perKey.get(key) ?? 0) >= this.keyLimit)) {
      signal.throwIfAborted();
      await new Promise<void>(resolve => {
        const ready = (): void => { this.wake.delete(ready); signal.removeEventListener('abort', ready); resolve(); };
        this.wake.add(ready); signal.addEventListener('abort', ready, { once: true });
      });
    }
    signal.throwIfAborted(); this.active++;
    if (key !== undefined) this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    try { return await action(); }
    finally {
      this.active--;
      if (key !== undefined) { const next = (this.perKey.get(key) ?? 1) - 1; if (next) this.perKey.set(key, next); else this.perKey.delete(key); }
      for (const ready of [...this.wake]) ready();
    }
  }
}
