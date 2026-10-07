CREATE TABLE IF NOT EXISTS links (
  slug       TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  slug     TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  country  TEXT,
  city     TEXT,
  device   TEXT,
  browser  TEXT,
  referrer TEXT
);

CREATE INDEX IF NOT EXISTS idx_clicks_slug_ts ON clicks (slug, ts);
