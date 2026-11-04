<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Tabata Sync: Architecture and Implementation Plan

Status: **phases 1–2 implemented** (contracts, schema, analysis engine, CLI); see
[README.md](README.md) for results. This document defines the components, interfaces, data
model and phases; deviations found during implementation are noted inline.

Two applications share one analysis core:

1. **Analysis Engine** (`engine`): a library plus CLI that imports audio, fingerprints it,
   detects beats and workout intervals, and stores everything in SQLite.
2. **Workout Player** (`player`): a local HTTP server plus browser UI that imports files,
   recognizes known tracks through the engine, and plays audio with a synchronized workout display.

## 1. Findings from the inspection

| Item | Finding | Consequence |
|---|---|---|
| Location | `ridrs_app/experiments/` holds standalone npm projects outside the pnpm workspace; excluded from root `tsconfig` and Biome. | New experiment `experiments/tabata-sync/`, own `package.json`, npm. |
| License | Ridrs is `AGPL-3.0-or-later`; docs `CC-BY-SA-4.0`. | Same licenses; every dependency must be AGPL-compatible. |
| Runtime | Node 26.10, TypeScript 6, macOS arm64 (M3 Pro). `node:sqlite` works (SQLite 3.53). | No native SQLite addon needed. |
| Tools | `ffmpeg`/`ffprobe` 8.1 installed. `whisper.cpp` and `chromaprint` available via Homebrew, not installed. | ffmpeg is a hard requirement; speech and Chromaprint are optional. |
| Test corpus | `Ridrs/music/Tabata Songs/`: 30 FLAC tracks, 44.1 kHz stereo, 241.8–244.4 s each (≈ 8 × (20 s + 10 s) plus intro/outro). Tags include title, album, ISRC, sometimes `BPM`. | Real-world evaluation set. Commercial music: **never committed**; tests that use it are opt-in via an environment variable. |
| Signal check | RMS per 0.5 s of *Eye of the Tiger (Tabata)*: the beat dominates the envelope; work/rest contrast is only a few dB in places. | Energy alone is too weak. Interval detection must fuse speech, transition sounds, spectral change and the periodic timing model. |

## 2. Technology decisions

| Concern | Choice | License | Why / alternatives rejected |
|---|---|---|---|
| Decoding, resampling, transcoding | **ffmpeg CLI** (system binary, child process) | LGPL/GPL, not linked | Handles MP3/WAV/FLAC/M4A/OGG/Opus. Spawned, not linked, so no licensing entanglement. Decode to mono float32 at 11 025 Hz (analysis) and 16 kHz (speech). *Implemented with ffmpeg's own windowed-sinc resampler: the installed build has no SoX resampler.* `ffmpeg-static` rejected: 70 MB per install, same binary. |
| Technical metadata | **ffprobe** JSON | as above | Duration, codec, sample rate, channels, bitrate, decoder info. |
| Tag metadata | **music-metadata** | MIT | Actively maintained; normalizes ID3v1/v2, Vorbis, MP4 and APE tags, which ffprobe returns raw. |
| FFT | **fft.js** | MIT | Pure JS radix-4, fast enough (one 4-min track ≈ 30 k frames). Stable, no open bugs worth noting. |
| Primary fingerprint | **Own spectral-landmark fingerprint** (Panako-style triplets) | ours | Needs tolerance to ±5 % speed change, partial matching, offset estimation and per-section match maps. No maintained JS library provides this. Chromaprint is not speed-tolerant and has coarse partial matching. |
| Secondary fingerprint | **Chromaprint `fpcalc`** (optional) | LGPL-2.1, spawned | Independent second opinion for the "probable match" band. Skipped when not installed. |
| Beat and tempo | **Own** onset envelope + tempogram + dynamic-programming beat tracker (Ellis 2007) | ours | Must expose alternative tempi (½×, 2×), local tempo changes and confidence. `essentia.js` (AGPL, compatible) was evaluated: last release 2022, WASM blob, no tempo-change output. Kept as an optional **dev-only benchmark** to validate our tracker, not a runtime dependency. |
| Speech recognition | **whisper.cpp `whisper-cli`** behind `SpeechRecognizer` (optional) | MIT | Local, Metal-accelerated on Apple Silicon, word-level timestamps in JSON. Model `base.en` (≈ 150 MB) default, configurable. `transformers.js` (ONNX) rejected as default: heavier install, slower on CPU. Node bindings (`smart-whisper`) rejected: native build, last release 2024. |
| Database | **`node:sqlite`** | built-in | Zero dependencies. Migrations as numbered SQL files. |
| Validation of contracts | **zod** | MIT | Already used in Ridrs; validates API payloads and stored JSON blobs. |
| HTTP server | **`node:http`** + own small router | built-in | ~10 endpoints, range requests for audio. Fastify not justified. |
| Player UI | **Vanilla TypeScript + Vite** | MIT | Plain DOM is enough for a library table and workout display. No framework. |
| Tests | **Vitest** | MIT | Same as the Ridrs workspace. |
| Synthetic speech for fixtures | macOS **`say`** (optional) | system | Generates "3, 2, 1, go" fixtures locally; speech tests are skipped where unavailable. |

Rejected outright: librosa, Essentia (Python/C++) and Python Whisper, because the stack is
TypeScript/Node by decision; any remote AI API, because the system must work offline.

## 3. Layout

```text
experiments/tabata-sync/
  package.json                npm workspaces: contracts, engine, player
  contracts/                  typed domain models + zod schemas; no runtime deps besides zod
  engine/
    src/decode/               AudioDecoder (ffmpeg), MetadataReader (ffprobe + music-metadata)
    src/dsp/                  STFT, mel bands, RMS, spectral flux, novelty curves
    src/fingerprint/          landmark extractor, hash index, matcher, Chromaprint adapter
    src/markers/              regular markers, significant-event detector
    src/rhythm/               onset envelope, tempo candidates, beat tracker
    src/speech/               SpeechRecognizer interface, WhisperCppRecognizer, NullRecognizer
    src/intervals/            evidence curves, spoken countdowns, regular grid model, corrections
    src/matching/             track/variant matcher, timeline mapper
    src/store/                SQLite repositories + migrations
    src/pipeline/             AnalysisPipeline orchestration, versioned parameters
    src/cli/                  `tabata analyze|match|show|correct|eval`
    test/                     unit tests + synthetic fixture generator
  player/
    src/server/               HTTP API over engine (library, import, analysis, audio streaming)
    src/web/                  playback engine, sync engine, workout view, library view
  eval/                       metric runners for the real corpus (opt-in)
```

`dependency-cruiser` rule: `player/src/web` may import only `contracts`; analysis code never
imports from `player`.

## 4. Component interfaces (abridged)

```ts
// contracts — times are seconds (float) on the variant's own timeline unless stated otherwise
interface DecodedAudio { samples: Float32Array; sampleRate: number; durationSec: number; decoder: DecoderInfo }
interface AudioDecoder { decode(path: string, opts: { sampleRate: number; mono: true }): Promise<DecodedAudio> }
interface MetadataReader { read(path: string): Promise<FileMetadata> }        // never writes the file

interface Fingerprinter {
  readonly id: string; readonly version: string
  extract(audio: DecodedAudio): FingerprintData                                 // landmarks/hashes
}
interface FingerprintIndex {
  add(variantId: string, fp: FingerprintData): void
  query(fp: FingerprintData): MatchCandidate[]                                   // ranked, with alignment
}
interface MatchResult {
  verdict: 'confident' | 'probable' | 'uncertain' | 'unknown'
  trackId?: string; variantId?: string
  similarity: number; confidence: number
  offsetSec: number; speedRatio: number
  transformations: DetectedTransformation[]                                      // gain, eq, silence, speed, local edit
  sections: { refStart: number; refEnd: number; queryStart: number; queryEnd: number; matched: boolean }[]
}

interface MarkerGenerator { regular(a: DecodedAudio, f: FeatureFrames, intervalSec: number): AudioMarker[]
                            significant(a: DecodedAudio, f: FeatureFrames): AudioMarker[] }
interface BeatTracker { analyze(f: FeatureFrames): RhythmAnalysis }             // bpm, alternatives, beats, tempo segments
interface SpeechRecognizer { readonly available: boolean
                             transcribe(a: DecodedAudio): Promise<SpeechSegment[]> }   // text, start, end, confidence, words

interface CandidateSource { readonly name: string
                            candidates(ctx: AnalysisContext): CandidateEvent[] } // speech, energy, flux, sfx, beats
interface WorkoutModeler { fit(c: CandidateEvent[], ctx: AnalysisContext): WorkoutStructure }

interface TimelineMap {                                                          // variant time -> reference time
  segments: { variantStart: number; variantEnd: number; refStart: number; speed: number; confidence: number }[]
  toReference(t: number): number | null                                         // null inside unmatched/modified sections
}
```

`CandidateEvent` carries `time`, `type` (`WorkoutStart`, `WarmupStart`, `WorkStart`,
`RecoveryStart`, `CountdownStart`, `IntervalEnd`, `FinalIntervalStart`, `WorkoutEnd`,
`CooldownStart`), `source`, `confidence`, `evidence` and optional `durationSec`.
`WorkoutStructure` holds intervals with type, boundaries, per-boundary and per-interval
confidence, supporting evidence ids and flagged deviations from the global pattern.

## 5. Key algorithms

### 5.1 Fingerprint (robust to gain, EQ, codecs, resampling, ±5 % speed, edits)

1. Resample to 11 025 Hz mono; STFT 1024/128 hop (shared with the feature extraction); log-magnitude.
2. Subtract each frame's power-mean level, then take local maxima in a time–frequency
   neighborhood, thinned to a fixed density per second. Removing the frame level makes peak
   positions immune to gain and compression pumping (hard 8:1 compression: similarity 0.005 → 0.54).
3. Hash **triplets** of peaks `(p1, p2, p3)`: quantized frequency bins plus the **ratio**
   `Δt12 / Δt13`. The ratio is invariant to playback speed; frequency is quantized coarsely
   and searched ±1 bin to tolerate small pitch shifts from speed changes.
4. Matching: look up hashes, then for every candidate variant fit `t_ref = a · t_query + b`
   with a Hough vote over `(b, a)` and a RANSAC refinement. `a` gives speed, `b` the offset.
5. Section map: slide 2 s windows; a window is *matched* when enough hashes agree with
   the fitted line. Unmatched runs become "modified section" entries; several line fits
   per variant are allowed (piecewise alignment, e.g. replaced intro).
6. Verdict from calibrated thresholds on matched-hash density and coverage, checked against
   the best **unrelated** track's score (margin test). Calibration uses the synthetic
   transformation suite and a cross-track impostor set (30 real tracks, similar BPM).
   Anything not clearly above the impostor distribution is `uncertain`; associating it is a user action.

### 5.2 Markers

* **Regular**: every `markerIntervalSec` (default 2.0, configurable) a compact descriptor
  (mel-band energy contour, chroma, RMS, flux, hash count) plus relevance and confidence.
* **Significant**: novelty peaks from several curves (RMS jump/drop, spectral flux, mel
  self-similarity checkerboard, percussive/harmonic ratio change, silence, speech-band
  activity), with type, strength, confidence, optional duration and the local fingerprint hashes.
* Markers are matched like fingerprints but at coarse resolution; they validate and refine
  the timeline map and allow re-sync after a modified section.

### 5.3 Tempo and beats

Onset strength from log-mel flux → autocorrelation tempogram per 8 s window → tempo
candidates with scores, explicit ½×/2× alternatives → DP beat tracker per tempo segment →
beat times with confidence. Tempo segments are kept when local tempo differs by > 4 %
for ≥ 8 s; no single global value is forced.

### 5.4 Interval detection: evidence → one regular grid

Only **regular** workouts are supported: one work length and one recovery length, repeated for
at least three rounds between a warm-up and a cooldown. Anything else is reported as "no regular
workout" rather than forced into a pattern. (Revised in phase 3; the first version segmented
irregular workouts with a semi-Markov model, see the README.)

1. **Evidence curves** from the audio at 22.05 kHz, 10 ms frames (`evidence.ts`):
   onsets (spectral flux), **cues** (a ±10 % band rising above its neighbours, or a whistle's
   15–50 Hz trill in 2.4–4.6 kHz; each band against its own usual values and against the 3 s
   around it, so recurring melody notes do not count), and signed **volume steps** (median level
   over 2 s after vs. before).
2. **Spoken countdowns** (`countdowns.ts`): two or more descending numbers; their zero is
   extrapolated from the number cadence and the command word ("go", "rest"…) that follows.
3. **Ranked evidence** (`grid.ts`): the beat nearest a countdown's zero (weight 3), cues (1.5),
   volume steps (1, matched within ±1.5 s, they only support a boundary and its type).
4. **Grid search**: evidence peaks are folded over every cycle length; the best work and
   recovery phases per cycle become hypotheses, together with their double, triple, half and
   third cycles. Each is placed (phase ±0.2 s, every work length) and scored: evidence at its
   boundaries, a cost per round, and how clearly work and recovery differ in level.
5. **Timing**: every peak of every precise source near a boundary is an observation; the grid
   most observations agree with (±50 ms) wins, then least squares on those. A cue is timed by
   where its own band rises, so drums and voices elsewhere do not move it.
6. **Checks**: significance against the same grid at shifted phases, at least 60 % of
   boundaries supported, no repeated volume steps against a boundary's direction.
7. Output per interval: type, start/end, confidence, evidence list (`pattern` where the grid
   alone places a boundary).


### 5.5 Known variants and synchronization

* Import a variant → fingerprint match → `TimelineMap` → reference analysis (beats,
  markers, intervals) mapped through it. Verification: mapped significant markers must
  re-appear in the variant within tolerance; failing sections are flagged and, if large,
  only those sections are re-analyzed.
* Player clock: the `<audio>` element's `currentTime` is authoritative. Between its
  coarse updates the display interpolates with `performance.now()` × `playbackRate`, and
  re-anchors on every `timeupdate`, `seeked`, `ratechange`, `playing`, `pause` and `waiting`.
  Output latency (`AudioContext.outputLatency`) is subtracted. No independent timer accumulates.
* Display time `t_ref = map.toReference(t_variant)`; inside an unmatched section the view
  shows "out of sync" and resumes at the next matched segment.

## 6. Database schema (SQLite, migration 001)

As implemented in `engine/src/store/migrations/001_initial.sql` (markers store scalar features as
JSON plus `descriptor` and `hashes` BLOBs; fingerprints store four parallel typed-array BLOBs):

```text
track(id, title, artist, created_at)                                   -- logical track
audio_file(id, path, filename, size_bytes, sha256, format, codec, duration_sec,
           sample_rate, channels, bitrate, tags_json, decoder_json, imported_at)
audio_variant(id, track_id→track, audio_file_id→audio_file, role, reference_variant_id,
              timeline_map_json, match_json, created_at)               -- role: reference|variant
analysis_run(id, variant_id, kind, engine_version, params_json, params_hash,
             status, started_at, finished_at, duration_ms, peak_rss_bytes, error)
fingerprint(id, run_id, variant_id, algorithm, version, data BLOB)
fingerprint_hash(hash INTEGER, variant_id, t_frame INTEGER)            -- index, WITHOUT ROWID
audio_marker(id, run_id, variant_id, kind, type, time_sec, duration_sec,
             relevance, confidence, features BLOB)
rhythm(run_id, variant_id, bpm, confidence, alternatives_json, tempo_segments_json, beats BLOB)
speech_segment(id, run_id, text, start_sec, end_sec, confidence, words_json)
detected_event(id, run_id, type, source, time_sec, duration_sec, confidence, evidence_json)
workout(id, run_id, variant_id, pattern_json, confidence, is_current)
interval(id, workout_id, idx, type, start_sec, end_sec, confidence, start_conf, end_conf,
         evidence_json, deviation_json)
manual_correction(id, track_id, target, action, payload_json, author, created_at, superseded_by)
match_candidate(id, audio_file_id, candidate_variant_id, verdict, score, confidence,
                details_json, resolved_by, resolved_at)                -- pending reviews
schema_migration(version, applied_at)
```

Rules: analysis results are append-only per `analysis_run`; "current" is a pointer, not a
deletion. Manual corrections live on the logical track in reference time, so they apply to
every variant and survive re-analysis. The effective workout = latest automatic result +
corrections overlay; the eval command reports automatic vs. corrected differences.

## 7. Player API (local, `127.0.0.1` only)

```text
GET  /api/tracks?q=&bpmMin=&bpmMax=&intervals=&status=&sort=   library search
POST /api/import            { paths[] } → per file: verdict, track, variant, job id
GET  /api/jobs/:id           analysis progress
GET  /api/tracks/:id         track, variants, effective workout, rhythm summary
GET  /api/variants/:id/timeline   workout in variant time + timeline map
POST /api/tracks/:id/corrections  manual correction
POST /api/match-candidates/:id/resolve  accept/reject an uncertain match
GET  /media/:audioFileId    original file, HTTP range requests (never modified)
```

UI strings live in `player/src/web/i18n/en.ts` behind a `t(key, params)` function; adding a
language is a new file only.

## 8. Testing and quality metrics

* **Synthetic generator** (deterministic, seeded): drum loops at chosen BPM, chord pads,
  work/rest sections with configurable contrast, beep/whistle transition sounds, optional
  `say` countdowns, background speech, misleading drops.
* **Transformation suite** via ffmpeg: gain ±12 dB, loudnorm, EQ, compressor, MP3 128k,
  AAC, Opus, 22.05/48 kHz, `atempo` 0.97–1.03, ±silence, intro cut/replace, local section
  replacement. Expected: identification + offset ±20 ms + speed ±0.2 %.
* **Impostors**: every corpus track against all others → false-positive rate, score margin.
* **Intervals**: boundary error (ms), classification accuracy, ablation global vs. independent,
  corrections survive re-analysis.
* **Sync**: simulated media clock (pause, seek both ways, rate 0.75–1.5, buffering stalls,
  variants with different intros) → max and mean error; drift over the full track.
* `tabata eval` writes a metrics JSON per engine version (precision, recall, FPR,
  calibration, BPM error, beat F-measure, boundary error, sync error, runtime, peak RSS),
  so algorithm versions can be compared.

Ground truth for the real corpus: one hand-labelled reference file per track
(`eval/labels/*.json`, our own labels, no audio), created with the player's correction UI.

## 9. Phases (each ends with green tests and a short findings note)

1. **Architecture** — this document; contracts package with types and zod schemas; migration 001.
2. **Analysis engine** — decode + metadata, DSP features, landmark fingerprint, markers, BPM/beats; CLI `analyze`.
3. **Interval detection** — speech adapter, evidence curves, regular grid fit, corrections; synthetic + corpus validation.
4. **Recognition and persistence** — index, matcher with verdicts, variants, timeline maps, re-analysis/versioning.
5. **Player** — server, library, import with recognition, playback + sync engine, workout view.
6. **Quality** — full metric run, drift measurement, performance work, fixes.

## 10. Open questions for review

1. **whisper.cpp** needs `brew install whisper-cpp` plus a ~150 MB model download. OK to make
   this the optional speech backend?
2. **Chromaprint** (`brew install chromaprint`) as optional second fingerprint: worth it, or
   landmark-only for now?
3. Player as **local web app in the browser** (proposed) or **Electron** like `hr-monitor-osx`?
4. Should the hand-labelled ground truth for the 30 corpus tracks be created early (Phase 3)?
   It is the only way to report real interval accuracy.
