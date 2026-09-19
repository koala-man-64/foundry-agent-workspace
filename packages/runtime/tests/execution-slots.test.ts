import { describe, expect, it } from 'vitest';
import { ExecutionSlots } from '../src/execution-slots';

describe('shared execution slots', () => {
  it('bounds global and per-profile concurrency and wakes waiters fairly', async () => {
    const slots = new ExecutionSlots(3, 2);
    let active = 0; let peak = 0; const perProfile = new Map<string, number>(); let peakProfile = 0;
    const run = (key?: string) => slots.use(new AbortController().signal, async () => {
      active++; peak = Math.max(peak, active);
      if (key) { perProfile.set(key, (perProfile.get(key) ?? 0) + 1); peakProfile = Math.max(peakProfile, perProfile.get(key)!); }
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; if (key) perProfile.set(key, perProfile.get(key)! - 1);
    }, key);
    await Promise.all([...Array.from({ length: 8 }, () => run('profile:a')), ...Array.from({ length: 4 }, () => run('profile:b')), run(), run()]);
    expect(peak).toBeLessThanOrEqual(3); expect(peakProfile).toBeLessThanOrEqual(2);
  });
  it('releases a waiting request on abort without occupying a slot', async () => {
    const slots = new ExecutionSlots(1, 1);
    let release!: () => void;
    const holding = slots.use(new AbortController().signal, () => new Promise<void>(resolve => { release = resolve; }), 'profile:a');
    const abort = new AbortController();
    const waiting = slots.use(abort.signal, async () => 'ran', 'profile:a');
    abort.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    release(); await holding;
    await expect(slots.use(new AbortController().signal, async () => 'ran', 'profile:a')).resolves.toBe('ran');
  });
});
