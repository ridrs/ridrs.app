-- Webhook mailbox of ridrs.app: registered devices and their encrypted event queue.
CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL,
  sign_pub   TEXT NOT NULL,
  enc_pub    TEXT NOT NULL,
  name       TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  last_ts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS devices_athlete ON devices (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS devices_last_seen ON devices (last_seen);

CREATE TABLE IF NOT EXISTS events (
  cursor     INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  device_id  TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  eph_pub    TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_device_cursor ON events (device_id, cursor);
CREATE INDEX IF NOT EXISTS events_created ON events (created_at);

-- Best-effort rate limit of POST /devices (key = sha256 of the client address).
CREATE TABLE IF NOT EXISTS rate_limits (
  key    TEXT NOT NULL,
  window INTEGER NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
