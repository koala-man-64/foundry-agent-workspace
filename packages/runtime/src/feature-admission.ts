import { FeatureRpc, FeatureSchema, type FeatureName, type FeatureReason, type FeatureSnapshot, type FeatureState } from '../../protocol/src/features';
import type { Store } from './store';

export const FEATURE_ADMISSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_features (feature TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), reason TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_feature_history (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, feature TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), reason TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_feature_history_feature ON workspace_feature_history(feature,ordinal);
`;

const FEATURES = FeatureSchema.options;
type Row = { feature: FeatureName; enabled: number; reason: FeatureReason | null; updated_at: string };
const state = (row: Row): FeatureState => ({ feature: row.feature, enabled: Boolean(row.enabled), reason: row.reason, updatedAt: row.updated_at });

/** Persistent admission switches; historical tasks, drafts, grants and recovery evidence are never deleted. */
export function newFeatureAdmission(store: Store) {
  const getOne = (feature: FeatureName): FeatureState => {
    if (store.schemaVersion < 5) return { feature, enabled: false, reason: 'migration-required', updatedAt: null };
    const row = store.db.prepare('SELECT feature,enabled,reason,updated_at FROM workspace_features WHERE feature = ?').get(feature) as Row | undefined;
    return row ? state(row) : { feature, enabled: true, reason: null, updatedAt: null };
  };
  return {
    get(feature: FeatureName): FeatureState { return getOne(feature); },
    snapshot(): FeatureSnapshot {
      const history = store.schemaVersion < 5 ? [] : (store.db.prepare('SELECT feature,enabled,reason,updated_at FROM workspace_feature_history ORDER BY ordinal DESC LIMIT 50').all() as Row[]).map(state);
      return { features: FEATURES.map(getOne), history };
    },
    set(input: { feature: FeatureName; enabled: boolean; reason?: FeatureReason }): FeatureState {
      const p = FeatureRpc['features.set'].parse(input);
      if (store.schemaVersion < 5) throw new Error('Feature admission requires the verified v5 migration.');
      const reason = p.enabled ? null : p.reason ?? 'user-paused';
      if (reason === 'migration-required') throw new Error('Only migration status may report migration-required.');
      const prior = getOne(p.feature);
      if (prior.enabled === p.enabled && prior.reason === reason) return prior;
      const updatedAt = new Date().toISOString();
      store.transaction(() => {
        store.db.prepare('INSERT INTO workspace_features(feature,enabled,reason,updated_at) VALUES(?,?,?,?) ON CONFLICT(feature) DO UPDATE SET enabled=excluded.enabled,reason=excluded.reason,updated_at=excluded.updated_at').run(p.feature, Number(p.enabled), reason, updatedAt);
        store.db.prepare('INSERT INTO workspace_feature_history(feature,enabled,reason,updated_at) VALUES(?,?,?,?)').run(p.feature, Number(p.enabled), reason, updatedAt);
      });
      return { feature: p.feature, enabled: p.enabled, reason, updatedAt };
    }
  };
}
