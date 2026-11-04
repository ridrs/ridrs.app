// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  AnalysisKind,
  AudioMarker,
  CandidateEvent,
  Correction,
  ComponentVersions,
  DecoderInfo,
  FileMetadata,
  FingerprintData,
  MarkerFeatures,
  RhythmAnalysis,
  SpeechSegment,
  TempoCandidate,
  TempoSegment,
  WorkoutInterval,
  WorkoutStructure,
} from '@tabata-sync/contracts';
import { CorrectionSchema } from '@tabata-sync/contracts';
import { transaction } from './database.ts';

type Row = Record<string, SQLInputValue>;
type TypedArray = Uint32Array | Float32Array | Float64Array;

function toBlob(array: TypedArray): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/** Copies a BLOB into a fresh, aligned typed array. Stored data is little-endian, like every supported host. */
function fromBlob<T extends TypedArray>(blob: Uint8Array, Type: { new (buffer: ArrayBuffer): T; BYTES_PER_ELEMENT: number }): T {
  const copy = new ArrayBuffer(blob.byteLength - (blob.byteLength % Type.BYTES_PER_ELEMENT));
  new Uint8Array(copy).set(blob.subarray(0, copy.byteLength));
  return new Type(copy);
}

function now(): string {
  return new Date().toISOString();
}

export interface VariantRecord {
  readonly id: string;
  readonly trackId: string;
  readonly audioFileId: string;
  readonly role: 'reference' | 'variant';
}

export interface RunRecord {
  readonly id: string;
  readonly variantId: string;
  readonly kind: AnalysisKind;
  readonly engineVersion: string;
  readonly paramsHash: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly startedAt: string;
  readonly durationMs: number | null;
}

export interface RunCompletion {
  readonly status: 'succeeded' | 'failed';
  readonly durationMs: number;
  readonly peakRssBytes?: number;
  readonly stageTimings?: Record<string, number>;
  readonly decoder?: DecoderInfo;
  readonly error?: string;
}

export interface TrackSummary {
  readonly trackId: string;
  readonly title: string | null;
  readonly artist: string | null;
  readonly variantId: string;
  readonly path: string;
  readonly durationSec: number;
  readonly format: string;
  readonly bpm: number | null;
  readonly runStatus: string | null;
}

/** All reads and writes of analysis data. Results are only ever added; history is never rewritten. */
export class AnalysisStore {
  constructor(readonly db: DatabaseSync) {}

  findAudioFileBySha(sha256: string): { id: string; path: string } | undefined {
    return this.db.prepare('SELECT id, path FROM audio_file WHERE sha256 = ?').get(sha256) as
      | { id: string; path: string }
      | undefined;
  }

  insertAudioFile(metadata: FileMetadata): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO audio_file (id, path, filename, size_bytes, sha256, format, container, codec, duration_sec,
           sample_rate, channels, bitrate, bits_per_sample, tags_json, probe_json, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        metadata.path,
        metadata.filename,
        metadata.sizeBytes,
        metadata.sha256,
        metadata.format,
        metadata.container,
        metadata.codec,
        metadata.durationSec,
        metadata.sampleRate,
        metadata.channels,
        metadata.bitrate ?? null,
        metadata.bitsPerSample ?? null,
        JSON.stringify(metadata.tags),
        JSON.stringify(metadata.probe),
        now(),
      );
    return id;
  }

  /** A file seen again under a new path keeps its identity; only the path is refreshed. */
  updateAudioFilePath(id: string, path: string): void {
    this.db.prepare('UPDATE audio_file SET path = ? WHERE id = ?').run(path, id);
  }

  createTrack(title: string | undefined, artist: string | undefined): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO track (id, title, artist, created_at) VALUES (?, ?, ?, ?)').run(id, title ?? null, artist ?? null, now());
    return id;
  }

  createVariant(trackId: string, audioFileId: string, role: VariantRecord['role'], referenceVariantId?: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO audio_variant (id, track_id, audio_file_id, role, reference_variant_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, trackId, audioFileId, role, referenceVariantId ?? null, now());
    return id;
  }

  variantForAudioFile(audioFileId: string): VariantRecord | undefined {
    return this.db
      .prepare('SELECT id, track_id AS trackId, audio_file_id AS audioFileId, role FROM audio_variant WHERE audio_file_id = ?')
      .get(audioFileId) as VariantRecord | undefined;
  }

  startRun(
    variantId: string,
    kind: AnalysisKind,
    engineVersion: string,
    versions: ComponentVersions,
    params: unknown,
    paramsHash: string,
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO analysis_run (id, variant_id, kind, engine_version, component_versions_json, params_json, params_hash, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, variantId, kind, engineVersion, JSON.stringify(versions), JSON.stringify(params), paramsHash, now());
    return id;
  }

  finishRun(runId: string, completion: RunCompletion): void {
    this.db
      .prepare(
        `UPDATE analysis_run SET status = ?, finished_at = ?, duration_ms = ?, peak_rss_bytes = ?, stage_timings_json = ?,
           decoder_json = ?, error = ? WHERE id = ?`,
      )
      .run(
        completion.status,
        now(),
        completion.durationMs,
        completion.peakRssBytes ?? null,
        completion.stageTimings ? JSON.stringify(completion.stageTimings) : null,
        completion.decoder ? JSON.stringify(completion.decoder) : null,
        completion.error ?? null,
        runId,
      );
  }

  runs(variantId: string): RunRecord[] {
    return this.db
      .prepare(
        `SELECT id, variant_id AS variantId, kind, engine_version AS engineVersion, params_hash AS paramsHash, status,
           started_at AS startedAt, duration_ms AS durationMs
         FROM analysis_run WHERE variant_id = ? ORDER BY started_at, rowid`,
      )
      .all(variantId) as unknown as RunRecord[];
  }

  latestSucceededRun(variantId: string, kind: AnalysisKind = 'full'): RunRecord | undefined {
    return this.runs(variantId)
      .filter((run) => run.status === 'succeeded' && run.kind === kind)
      .at(-1);
  }

  /** Persists all results of one run atomically. */
  saveResults(
    runId: string,
    variantId: string,
    results: { fingerprint: FingerprintData; rhythm: RhythmAnalysis; markers: readonly AudioMarker[] },
  ): void {
    transaction(this.db, () => {
      const fp = results.fingerprint;
      this.db
        .prepare(
          `INSERT INTO fingerprint (id, run_id, variant_id, algorithm, version, frame_rate, hash_count, hashes, times, spans, pitches)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), runId, variantId, fp.algorithm, fp.version, fp.frameRate, fp.hashes.length, toBlob(fp.hashes), toBlob(fp.times), toBlob(fp.spans), toBlob(fp.pitches));

      const r = results.rhythm;
      this.db
        .prepare(
          `INSERT INTO rhythm (run_id, variant_id, bpm, confidence, alternatives_json, tempo_segments_json, beat_count, beats, beat_strengths)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, variantId, r.bpm, r.confidence, JSON.stringify(r.alternatives), JSON.stringify(r.tempoSegments), r.beats.length, toBlob(r.beats), toBlob(r.beatStrengths));

      const insertMarker = this.db.prepare(
        `INSERT INTO audio_marker (id, run_id, variant_id, kind, type, time_sec, duration_sec, relevance, confidence, features_json, descriptor, hashes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of results.markers) {
        insertMarker.run(randomUUID(), runId, variantId, m.kind, m.type, m.timeSec, m.durationSec ?? null, m.relevance, m.confidence, JSON.stringify(m.features), toBlob(m.descriptor), toBlob(m.hashes));
      }
    });
  }

  loadFingerprint(runId: string): FingerprintData | undefined {
    const row = this.db.prepare('SELECT * FROM fingerprint WHERE run_id = ?').get(runId) as Row | undefined;
    if (!row) return undefined;
    return {
      algorithm: row.algorithm as string,
      version: row.version as string,
      frameRate: row.frame_rate as number,
      hashes: fromBlob(row.hashes as Uint8Array, Uint32Array),
      times: fromBlob(row.times as Uint8Array, Float32Array),
      spans: fromBlob(row.spans as Uint8Array, Float32Array),
      pitches: fromBlob(row.pitches as Uint8Array, Float32Array),
    };
  }

  loadRhythm(runId: string): RhythmAnalysis | undefined {
    const row = this.db.prepare('SELECT * FROM rhythm WHERE run_id = ?').get(runId) as Row | undefined;
    if (!row) return undefined;
    return {
      bpm: row.bpm as number,
      confidence: row.confidence as number,
      alternatives: JSON.parse(row.alternatives_json as string) as TempoCandidate[],
      tempoSegments: JSON.parse(row.tempo_segments_json as string) as TempoSegment[],
      beats: fromBlob(row.beats as Uint8Array, Float64Array),
      beatStrengths: fromBlob(row.beat_strengths as Uint8Array, Float32Array),
    };
  }

  loadMarkers(runId: string): AudioMarker[] {
    const rows = this.db.prepare('SELECT * FROM audio_marker WHERE run_id = ? ORDER BY time_sec, rowid').all(runId) as Row[];
    return rows.map((row) => ({
      kind: row.kind as AudioMarker['kind'],
      type: row.type as AudioMarker['type'],
      timeSec: row.time_sec as number,
      ...(row.duration_sec !== null ? { durationSec: row.duration_sec as number } : {}),
      relevance: row.relevance as number,
      confidence: row.confidence as number,
      features: JSON.parse(row.features_json as string) as MarkerFeatures,
      descriptor: fromBlob(row.descriptor as Uint8Array, Float32Array),
      hashes: fromBlob(row.hashes as Uint8Array, Uint32Array),
    }));
  }

  saveSpeech(runId: string, segments: readonly SpeechSegment[]): void {
    transaction(this.db, () => {
      const insert = this.db.prepare(
        'INSERT INTO speech_segment (id, run_id, text, start_sec, end_sec, confidence, words_json, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const s of segments) {
        insert.run(randomUUID(), runId, s.text, s.startSec, s.endSec, s.confidence, s.words ? JSON.stringify(s.words) : null, s.classification ?? null);
      }
    });
  }

  loadSpeech(runId: string): SpeechSegment[] {
    const rows = this.db.prepare('SELECT * FROM speech_segment WHERE run_id = ? ORDER BY start_sec, rowid').all(runId) as Row[];
    return rows.map((row) => ({
      text: row.text as string,
      startSec: row.start_sec as number,
      endSec: row.end_sec as number,
      confidence: row.confidence as number,
      ...(row.words_json ? { words: JSON.parse(row.words_json as string) as NonNullable<SpeechSegment['words']> } : {}),
      ...(row.classification ? { classification: row.classification as string } : {}),
    }));
  }

  /** Stores the candidates and the resulting workout of one interval detection run. */
  saveIntervals(runId: string, variantId: string, candidates: readonly CandidateEvent[], structure: WorkoutStructure): void {
    transaction(this.db, () => {
      const insertEvent = this.db.prepare(
        'INSERT INTO detected_event (id, run_id, type, source, time_sec, duration_sec, confidence, uncertainty_sec, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const c of candidates) {
        insertEvent.run(randomUUID(), runId, c.type, c.source, c.timeSec, c.durationSec ?? null, c.confidence, c.uncertaintySec, JSON.stringify(c.evidence));
      }
      const workoutId = randomUUID();
      this.db
        .prepare('INSERT INTO workout (id, run_id, variant_id, pattern_json, confidence, details_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          workoutId,
          runId,
          variantId,
          JSON.stringify(structure.pattern),
          structure.confidence,
          JSON.stringify({ workoutStartSec: structure.workoutStartSec, workoutEndSec: structure.workoutEndSec }),
        );
      const insertInterval = this.db.prepare(
        `INSERT INTO interval (id, workout_id, idx, type, start_sec, end_sec, confidence, start_confidence, end_confidence,
           evidence_json, deviation_json, round, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of structure.intervals) {
        insertInterval.run(randomUUID(), workoutId, i.index, i.type, i.startSec, i.endSec, i.confidence, i.startConfidence, i.endConfidence,
          JSON.stringify(i.evidence), i.deviation ? JSON.stringify(i.deviation) : null, i.round ?? null, i.source);
      }
    });
  }

  loadCandidates(runId: string): CandidateEvent[] {
    const rows = this.db.prepare('SELECT * FROM detected_event WHERE run_id = ? ORDER BY time_sec, rowid').all(runId) as Row[];
    return rows.map((row) => ({
      timeSec: row.time_sec as number,
      type: row.type as CandidateEvent['type'],
      source: row.source as string,
      confidence: row.confidence as number,
      uncertaintySec: row.uncertainty_sec as number,
      evidence: JSON.parse(row.evidence_json as string) as Record<string, unknown>,
      ...(row.duration_sec !== null ? { durationSec: row.duration_sec as number } : {}),
    }));
  }

  loadWorkout(runId: string): WorkoutStructure | undefined {
    const workout = this.db.prepare('SELECT * FROM workout WHERE run_id = ?').get(runId) as Row | undefined;
    if (!workout) return undefined;
    const rows = this.db.prepare('SELECT * FROM interval WHERE workout_id = ? ORDER BY idx').all(workout.id as string) as Row[];
    const details = JSON.parse((workout.details_json as string | null) ?? '{}') as { workoutStartSec?: number; workoutEndSec?: number };
    return {
      pattern: JSON.parse(workout.pattern_json as string) as WorkoutStructure['pattern'],
      ...(details.workoutStartSec !== undefined ? { workoutStartSec: details.workoutStartSec } : {}),
      ...(details.workoutEndSec !== undefined ? { workoutEndSec: details.workoutEndSec } : {}),
      confidence: workout.confidence as number,
      intervals: rows.map(
        (row): WorkoutInterval => ({
          index: row.idx as number,
          type: row.type as WorkoutInterval['type'],
          startSec: row.start_sec as number,
          endSec: row.end_sec as number,
          ...(row.round !== null ? { round: row.round as number } : {}),
          confidence: row.confidence as number,
          startConfidence: row.start_confidence as number,
          endConfidence: row.end_confidence as number,
          evidence: JSON.parse(row.evidence_json as string) as string[],
          source: row.source as WorkoutInterval['source'],
          ...(row.deviation_json ? { deviation: JSON.parse(row.deviation_json as string) as NonNullable<WorkoutInterval['deviation']> } : {}),
        }),
      ),
    };
  }

  variant(variantId: string): (VariantRecord & { durationSec: number; path: string }) | undefined {
    return this.db
      .prepare(
        `SELECT v.id, v.track_id AS trackId, v.audio_file_id AS audioFileId, v.role, f.duration_sec AS durationSec, f.path
         FROM audio_variant v JOIN audio_file f ON f.id = v.audio_file_id WHERE v.id = ?`,
      )
      .get(variantId) as (VariantRecord & { durationSec: number; path: string }) | undefined;
  }

  /** Reference variants with a successful base analysis: the library for cross-track cues. */
  analyzedReferences(): Array<{ variantId: string; trackId: string; runId: string }> {
    const variants = this.db.prepare("SELECT id, track_id AS trackId FROM audio_variant WHERE role = 'reference'").all() as Array<{ id: string; trackId: string }>;
    return variants.flatMap((v) => {
      const run = this.latestSucceededRun(v.id);
      return run ? [{ variantId: v.id, trackId: v.trackId, runId: run.id }] : [];
    });
  }

  /** Corrections are stored per logical track and never overwritten; a newer one may supersede an older one. */
  addCorrection(trackId: string, correction: Correction, author?: string): string {
    const parsed = CorrectionSchema.parse(correction);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO manual_correction (id, track_id, target, action, payload_json, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, trackId, 'workout', parsed.action, JSON.stringify(parsed), author ?? null, now());
    return id;
  }

  supersedeCorrection(id: string, byId: string): void {
    this.db.prepare('UPDATE manual_correction SET superseded_by = ? WHERE id = ?').run(byId, id);
  }

  /** Withdraws every active correction of a track; a withdrawn correction supersedes itself. Nothing is deleted. */
  withdrawCorrections(trackId: string): number {
    return Number(
      this.db.prepare('UPDATE manual_correction SET superseded_by = id WHERE track_id = ? AND superseded_by IS NULL').run(trackId).changes,
    );
  }

  corrections(trackId: string): Array<{ id: string; correction: Correction; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT id, payload_json, created_at FROM manual_correction WHERE track_id = ? AND superseded_by IS NULL ORDER BY created_at, rowid')
      .all(trackId) as Array<{ id: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, correction: CorrectionSchema.parse(JSON.parse(row.payload_json)), createdAt: row.created_at }));
  }

  listTracks(): TrackSummary[] {
    return this.db
      .prepare(
        `SELECT t.id AS trackId, t.title, t.artist, v.id AS variantId, f.path, f.duration_sec AS durationSec, f.format,
           (SELECT r.bpm FROM rhythm r JOIN analysis_run ar ON ar.id = r.run_id
              WHERE ar.variant_id = v.id AND ar.status = 'succeeded' ORDER BY ar.started_at DESC, ar.rowid DESC LIMIT 1) AS bpm,
           (SELECT ar.status FROM analysis_run ar WHERE ar.variant_id = v.id ORDER BY ar.started_at DESC, ar.rowid DESC LIMIT 1) AS runStatus
         FROM track t JOIN audio_variant v ON v.track_id = t.id JOIN audio_file f ON f.id = v.audio_file_id
         ORDER BY t.title, f.path`,
      )
      .all() as unknown as TrackSummary[];
  }
}
