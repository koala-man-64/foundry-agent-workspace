import { describe, expect, it } from 'vitest';
import { GRANT_EXPIRY_MARGIN_MS, grantExpiresAt } from './AutomationSettings';

describe('script grant expiry', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  // The runtime's grant check (packages/runtime/src/automation.ts) refuses an expiry past its own clock plus 30 days.
  const runtimeAccepts = (expiresAt: string, runtimeNow: number) => Date.parse(expiresAt) > runtimeNow && Date.parse(expiresAt) <= runtimeNow + 30 * day;

  it('keeps the default 30-day request inside the runtime limit when the runtime clock reads behind', () => {
    const expiresAt = grantExpiresAt(30, now);
    expect(expiresAt).toBe(new Date(now + 30 * day - GRANT_EXPIRY_MARGIN_MS).toISOString());
    for (const behind of [0, 1, 16, 1_000, GRANT_EXPIRY_MARGIN_MS]) expect(runtimeAccepts(expiresAt, now - behind)).toBe(true);
  });

  it('keeps the shortest grant acceptable', () => {
    expect(runtimeAccepts(grantExpiresAt(1, now), now)).toBe(true);
  });
});
