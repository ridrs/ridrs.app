-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Phase 3: round numbers and origin of intervals, timing uncertainty of candidate events.

ALTER TABLE interval ADD COLUMN round INTEGER;
ALTER TABLE interval ADD COLUMN source TEXT NOT NULL DEFAULT 'automatic';
ALTER TABLE detected_event ADD COLUMN uncertainty_sec REAL NOT NULL DEFAULT 0.5;
ALTER TABLE workout ADD COLUMN details_json TEXT;
CREATE INDEX workout_run ON workout(run_id);
CREATE INDEX speech_segment_run ON speech_segment(run_id, start_sec);
