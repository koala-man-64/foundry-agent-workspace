import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { newFeatureAdmission } from '../src/feature-admission';

describe('persistent feature admission', () => {
  let directory: string; let store: Store;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'foundry-feature-test-')); store = new Store(join(directory, 'state.db')); });
  afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });

  it('defaults verified v5 features on, persists disable reason and history across reopen, and requires explicit reenable', () => {
    const admission = newFeatureAdmission(store);
    expect(admission.snapshot().features).toMatchObject([{ feature: 'archive', enabled: true }, { feature: 'hooks', enabled: true }, { feature: 'scheduling', enabled: true }]);
    admission.set({ feature: 'hooks', enabled: false, reason: 'runtime-fault' });
    expect(newFeatureAdmission(store).get('hooks')).toMatchObject({ enabled: false, reason: 'runtime-fault' });
    expect(admission.snapshot().history).toHaveLength(1);
    expect(admission.set({ feature: 'hooks', enabled: false, reason: 'runtime-fault' }).enabled).toBe(false);
    expect(admission.snapshot().history).toHaveLength(1);
    admission.set({ feature: 'hooks', enabled: true });
    expect(admission.snapshot().history).toHaveLength(2);
    expect(admission.get('hooks')).toMatchObject({ enabled: true, reason: null });
  });

  it('does not admit features before migration or persist arbitrary failure text', () => {
    const legacy = { schemaVersion: 2 } as Store;
    const admission = newFeatureAdmission(legacy);
    expect(admission.snapshot().features.every(item => !item.enabled && item.reason === 'migration-required')).toBe(true);
    expect(() => admission.set({ feature: 'hooks', enabled: true })).toThrow('verified v5');
    expect(() => newFeatureAdmission(store).set({ feature: 'hooks', enabled: false, reason: 'password=secret' as 'runtime-fault' })).toThrow();
  });
});
