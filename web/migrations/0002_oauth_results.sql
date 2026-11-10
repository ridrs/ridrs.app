-- Result of an intervals.icu sign-in, reported by the app and shown on the relay's bounce page.
-- state_hash is base64url(sha256(state)): the raw state is never stored. Rows live for 10 minutes.
CREATE TABLE IF NOT EXISTS oauth_results (
  state_hash TEXT PRIMARY KEY,
  ok         INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_results_created ON oauth_results (created_at);
