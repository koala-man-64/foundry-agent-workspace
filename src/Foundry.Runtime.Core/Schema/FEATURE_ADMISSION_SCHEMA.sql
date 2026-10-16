
CREATE TABLE IF NOT EXISTS workspace_features (feature TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), reason TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_feature_history (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, feature TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), reason TEXT, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_feature_history_feature ON workspace_feature_history(feature,ordinal);
