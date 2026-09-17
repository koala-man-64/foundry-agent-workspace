/** Waiting for a user decision never occupies an execution slot. */
export class ExecutionSlots {
  private active = 0;
  private readonly wake = new Set<() => void>();
  constructor(private readonly limit = 3) {}
  async use<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      signal.throwIfAborted();
      await new Promise<void>(resolve => {
        const ready = (): void => { this.wake.delete(ready); signal.removeEventListener('abort', ready); resolve(); };
        this.wake.add(ready); signal.addEventListener('abort', ready, { once: true });
      });
    }
    signal.throwIfAborted(); this.active++;
    try { return await action(); }
    finally { this.active--; for (const ready of [...this.wake]) ready(); }
  }
}
