-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Initial schema. Analysis results are append-only per analysis_run; nothing here deletes history.

CREATE TABLE track (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  artist      TEXT,
  created_at  TEXT NOT NULL
);

-- One row per physical file. The file on disk is referenced, never copied or modified.
CREATE TABLE audio_file (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  filename      TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL UNIQUE,
  format        TEXT NOT NULL,
  container     TEXT NOT NULL,
  codec         TEXT NOT NULL,
  duration_sec  REAL NOT NULL,
  sample_rate   INTEGER NOT NULL,
  channels      INTEGER NOT NULL,
  bitrate       INTEGER,
  bits_per_sample INTEGER,
  tags_json     TEXT NOT NULL,
  probe_json    TEXT NOT NULL,
  imported_at   TEXT NOT NULL
);

-- A physical rendition of a logical track. The reference variant owns the analysis timeline;
-- other variants map onto it through timeline_map_json.
CREATE TABLE audio_variant (
  id                    TEXT PRIMARY KEY,
  track_id              TEXT NOT NULL REFERENCES track(id),
  audio_file_id         TEXT NOT NULL UNIQUE REFERENCES audio_file(id),
  role                  TEXT NOT NULL CHECK (role IN ('reference', 'variant')),
  reference_variant_id  TEXT REFERENCES audio_variant(id),
  timeline_map_json     TEXT,
  match_json            TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX audio_variant_track ON audio_variant(track_id);

CREATE TABLE analysis_run (
  id                  TEXT PRIMARY KEY,
  variant_id          TEXT NOT NULL REFERENCES audio_variant(id),
  kind                TEXT NOT NULL,
  engine_version      TEXT NOT NULL,
  component_versions_json TEXT NOT NULL,
  params_json         TEXT NOT NULL,
  params_hash         TEXT NOT NULL,
  decoder_json        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  duration_ms         REAL,
  peak_rss_bytes      INTEGER,
  stage_timings_json  TEXT,
  error               TEXT
);
CREATE INDEX analysis_run_variant ON analysis_run(variant_id, started_at);

CREATE TABLE fingerprint (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES analysis_run(id),
  variant_id  TEXT NOT NULL REFERENCES audio_variant(id),
  algorithm   TEXT NOT NULL,
  version     TEXT NOT NULL,
  frame_rate  REAL NOT NULL,
  hash_count  INTEGER NOT NULL,
  hashes      BLOB NOT NULL,  -- Uint32 little-endian
  times       BLOB NOT NULL,  -- Float32
  spans       BLOB NOT NULL,  -- Float32
  pitches     BLOB NOT NULL   -- Float32
);
CREATE INDEX fingerprint_variant ON fingerprint(variant_id);

-- Inverted hash index for library-wide matching (filled by the matcher, phase 4).
CREATE TABLE fingerprint_hash (
  hash            INTEGER NOT NULL,
  fingerprint_id  TEXT NOT NULL REFERENCES fingerprint(id),
  time_frame      REAL NOT NULL,
  span_frames     REAL NOT NULL,
  pitch           REAL NOT NULL,
  PRIMARY KEY (hash, fingerprint_id, time_frame)
) WITHOUT ROWID;

CREATE TABLE audio_marker (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES analysis_run(id),
  variant_id     TEXT NOT NULL REFERENCES audio_variant(id),
  kind           TEXT NOT NULL CHECK (kind IN ('regular', 'significant')),
  type           TEXT NOT NULL,
  time_sec       REAL NOT NULL,
  duration_sec   REAL,
  relevance      REAL NOT NULL,
  confidence     REAL NOT NULL,
  features_json  TEXT NOT NULL,
  descriptor     BLOB NOT NULL,  -- Float32
  hashes         BLOB NOT NULL   -- Uint32
);
CREATE INDEX audio_marker_run ON audio_marker(run_id, time_sec);

CREATE TABLE rhythm (
  run_id               TEXT PRIMARY KEY REFERENCES analysis_run(id),
  variant_id           TEXT NOT NULL REFERENCES audio_variant(id),
  bpm                  REAL NOT NULL,
  confidence           REAL NOT NULL,
  alternatives_json    TEXT NOT NULL,
  tempo_segments_json  TEXT NOT NULL,
  beat_count           INTEGER NOT NULL,
  beats                BLOB NOT NULL,          -- Float64 seconds
  beat_strengths       BLOB NOT NULL           -- Float32
);

CREATE TABLE speech_segment (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES analysis_run(id),
  text        TEXT NOT NULL,
  start_sec   REAL NOT NULL,
  end_sec     REAL NOT NULL,
  confidence  REAL NOT NULL,
  words_json  TEXT,
  classification TEXT
);

CREATE TABLE detected_event (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES analysis_run(id),
  type           TEXT NOT NULL,
  source         TEXT NOT NULL,
  time_sec       REAL NOT NULL,
  duration_sec   REAL,
  confidence     REAL NOT NULL,
  evidence_json  TEXT NOT NULL
);
CREATE INDEX detected_event_run ON detected_event(run_id, time_sec);

CREATE TABLE workout (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES analysis_run(id),
  variant_id    TEXT NOT NULL REFERENCES audio_variant(id),
  pattern_json  TEXT NOT NULL,
  confidence    REAL NOT NULL
);

CREATE TABLE interval (
  id                TEXT PRIMARY KEY,
  workout_id        TEXT NOT NULL REFERENCES workout(id),
  idx               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  start_sec         REAL NOT NULL,
  end_sec           REAL NOT NULL,
  confidence        REAL NOT NULL,
  start_confidence  REAL NOT NULL,
  end_confidence    REAL NOT NULL,
  evidence_json     TEXT NOT NULL,
  deviation_json    TEXT,
  UNIQUE (workout_id, idx)
);

-- Corrections belong to the logical track and use reference time, so they survive re-analysis
-- and apply to every variant.
CREATE TABLE manual_correction (
  id             TEXT PRIMARY KEY,
  track_id       TEXT NOT NULL REFERENCES track(id),
  target         TEXT NOT NULL,
  action         TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  author         TEXT,
  created_at     TEXT NOT NULL,
  superseded_by  TEXT REFERENCES manual_correction(id)
);
CREATE INDEX manual_correction_track ON manual_correction(track_id);

CREATE TABLE match_candidate (
  id                    TEXT PRIMARY KEY,
  audio_file_id         TEXT NOT NULL REFERENCES audio_file(id),
  candidate_variant_id  TEXT NOT NULL REFERENCES audio_variant(id),
  verdict               TEXT NOT NULL,
  score                 REAL NOT NULL,
  confidence            REAL NOT NULL,
  details_json          TEXT NOT NULL,
  resolved_by           TEXT,
  resolved_at           TEXT
);
