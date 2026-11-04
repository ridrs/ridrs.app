<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Tabata Sync

Analyzes workout music (fingerprints, markers, tempo and beats, speech, workout intervals) and,
in a later phase, plays it with a synchronized interval display. Everything runs locally.
Design and plan: [ARCHITECTURE.md](ARCHITECTURE.md).

| Phase | Scope | Status |
|---|---|---|
| 1 | Architecture, contracts, database schema | done |
| 2 | Analysis engine: decoding, metadata, fingerprint, markers, tempo and beats, CLI | done |
| 3 | Interval detection (speech, candidates, global timing model, corrections) | done |
| 4 | Track and variant recognition, timeline maps | next |
| 5 | Player | open |
| 6 | Quality assurance | open |

## Requirements

- Node.js 26 (uses the built-in `node:sqlite`)
- `ffmpeg` and `ffprobe` on the `PATH` (`brew install ffmpeg`)
- Optional, for speech: `whisper-cli` (`brew install whisper-cpp`) and the `base.en` model at
  `~/.cache/tabata-sync/models/ggml-base.en.bin` (or `$TABATA_WHISPER_MODEL`):

  ```bash
  mkdir -p ~/.cache/tabata-sync/models
  curl -L -o ~/.cache/tabata-sync/models/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```

  Without it, analysis runs without speech evidence.

## Setup

```bash
npm install
```

## Command line

```bash
# Analyze files or whole folders; results go to data/tabata.db (or --db / $TABATA_DB)
npm run tabata -- analyze "/path/to/music"

npm run tabata -- list
npm run tabata -- show "/path/to/track.flac"

# The detected workout, with manual corrections applied
npm run tabata -- intervals "/path/to/track.flac"

# Manual corrections (seconds, reference timeline); they survive re-analysis
npm run tabata -- correct "/path/to/track.flac" move 30.4 30.0
npm run tabata -- correct "/path/to/track.flac" type 95 recovery
# Label a whole workout (replaces all earlier labels of the track)
npm run tabata -- correct "/path/to/track.flac" grid 10 20 10 8            # start, work, recovery, rounds
npm run tabata -- correct "/path/to/track.flac" label 10 30 40 60 ... 240  # work, recovery, ..., end
npm run tabata -- corrections "/path/to/track.flac"   # list + automatic-vs-corrected comparison

# Fingerprint alignment of two files, without the database
npm run tabata -- compare variant.mp3 original.flac
```

Options: `--db <path>`, `--force` (re-analyze even if an identical analysis exists),
`--marker-interval <sec>` (regular marker grid, default 2), `--no-speech`, `--json`.

`analyze` runs the base analysis of every file, then interval detection, which decodes the audio
once more for beats, cues and volume (≈ 2.5 s per track).

Re-running `analyze` reuses an earlier analysis with the same engine version and parameters.
Changing a parameter or `--force` adds a new analysis run; earlier runs stay in the database.

## Tests

```bash
npm run typecheck
npm test
```

The suite renders synthetic tracks (seeded, deterministic) and modifies them with ffmpeg,
so it needs no audio files. An extra evaluation runs against a local folder of real tracks,
which are never committed:

```bash
TABATA_CORPUS="/path/to/Tabata Songs" npm test -- corpus
```

## Layout

```text
contracts/src/      typed domain models and zod schemas shared by engine and player
engine/src/
  decode/           ffmpeg decoder, ffprobe + music-metadata reader
  dsp/              spectrogram, mel bands, frame features, signal helpers
  fingerprint/      speed-invariant landmark triplets, Hough alignment
  markers/          regular grid markers and significant event markers
  rhythm/           onset envelope, tempo candidates, tempo segments, beat tracker
  speech/           speech recognizer interface, whisper.cpp adapter (chunked, word timestamps)
  intervals/        evidence curves, spoken countdowns, regular grid model, manual corrections
  store/            SQLite migrations and the analysis store
  pipeline/         parameters, versions, analysis orchestration
  cli/              `tabata` command line
engine/test/        synthetic track and workout generators, corpus evaluation
```

## Phase 2 results

Synthetic suite (34 tests, ~14 s):

| Modification of a 40 s track | Similarity | Offset error | Speed found |
|---|---|---|---|
| identical copy | 1.000 | 0 ms | 1.0000 |
| gain −12 dB | 0.987 | 0 ms | 1.0000 |
| resampled to 16 / 48 kHz | 0.998 / 1.000 | 0 ms | 1.0000 |
| MP3 128k / AAC 96k / Opus 64k | 0.945 / 0.826 / 0.717 | ≤ 0.1 ms | 1.0000 |
| loudness normalization | 0.754 | 0.1 ms | 1.0000 |
| dynamic compression (8:1, 5 ms attack) | 0.535 | 0.2 ms | 1.0000 |
| equalization (±9 dB) | 0.522 | 0.4 ms | 1.0000 |
| added pink noise | 0.428 | 0.4 ms | 1.0000 |
| 3 s leading silence / first 5 s removed | 0.822 / 0.829 | 0 ms | 1.0000 |
| tempo +3 % / −2 % (pitch kept) | 0.620 / 0.621 | 8–10 ms | 1.0300 / 0.9800 |
| speed +2 % by resampling (pitch shifted) | 0.474 | 0.1 ms | 1.0200 (pitch 1.02) |
| unrelated track, same tempo and style | < 0.03 | — | — |

Tempo: error < 0.5 BPM at 90/128/160 BPM, beat F-measure > 0.95 (±70 ms), a 110 → 132 BPM
change is kept as two segments, half and double tempo are reported as alternatives.
Markers: volume steps, pauses, drops and a one-off whistle are found at the right time, and
the marker set does not change with a 12 dB gain change.

Real corpus (30 tracks, opt-in):

- BPM equals the embedded tag on 20 of 21 tagged tracks. The exception, *Burn*, is tagged 96 but
  its onset autocorrelation shows a steady 129.8 BPM pulse in every 20 s section and no
  periodicity at 96; the tag is most likely wrong.
- Highest similarity between two different tracks: 0.013. A modified real track (MP3, +2 % tempo,
  −6 dB, intro cut) is found among all 30 with offset error < 30 ms.
- Analysis time ≈ 3.8 s per 4-minute track on an M3 Pro (all stages, single-threaded),
  peak memory ≈ 680 MB for the whole 30-track batch.

## Phase 3 results

Only regular workouts are supported: every work interval has one length, every recovery
another, for at least three rounds. Anything else is reported as no regular workout.

How interval detection works (details in ARCHITECTURE.md 5.4):

- **Evidence, ranked**: the beat nearest a spoken countdown's zero (strongest), cues such as
  whistles and beeps, then volume steps (weakest; they support a boundary and its type, not its
  exact time).
- **One grid per track**: start, work length, recovery length and rounds that explain the most
  evidence. Boundaries without evidence of their own are placed by the grid and marked `pattern`.
- **Timing**: the grid that most precise observations agree with; a cue is timed by where its own
  frequency band rises.

Synthetic suite (all pass): 20/10, 30/15 and 40/20 workouts within 15 ms, five missing cues
filled from the pattern, drops and steady whistles inside intervals, a replaced section, spoken
countdowns only, an irregular workout reported as none, and whistle and beep timing in busy music.
One known limitation is kept as an expected failure: synthetic music that repeats exactly every
four bars outweighs three rounds of a 120/60 workout whose work beeps the music partly masks.

Real corpus (30 tracks; hand labels so far for *Shake It Off*):

| Result | Tracks |
|---|---|
| 8 × ~20/10 s, starting at 0:09.3–0:10.0 | 22 (incl. *Shake It Off*, *Can't Stop The Feeling*, *Don't Start Now*) |
| 8 × ~20/10 s, starting at 0:08.9–0:09.1 | *Back in Black*, *Beautiful People* |
| 8 rounds, 21–22.6 s work | *Fast Car*, *Heaven is a Place On Earth*, *Pump Up The Jam*, *Sweet Child O' Mine* |
| 7 × 24/6 s | *Higher Love* |
| 6 rounds | *Uptown Funk* |
| no regular workout | *I Wanna Dance With Somebody* |

- *Shake It Off* against the hand labels: all 16 boundaries, mean error 44 ms, max 239 ms (a
  late tap). The previous model matched 4 of them, 0.65–1.3 s off.
- The rows below the first two are unverified; they need labels before anyone tunes for them.
- Interval detection takes ≈ 2.5 s per track (decode, curves, fit); base analysis with speech
  stays ≈ 28 s.

Lessons from the corpus:

1. **The boundary is the beat at the start of "go"**, about 0.5 s before the spoken command ends
   (*Cake by the Ocean*: the beat nearest each countdown's zero sits at grid − 0.50 s, 9 times).
   The "0.21 s early" bias of the previous model came from measuring against the end of "go".
2. **Whisper timestamps are not precise enough to choose a beat** (*Shake It Off*: countdown zeros
   0.4–0.7 s late; synthetic voices stretch numbers over seconds). Countdowns say "a boundary within
   about half a second"; the beats there and the grid choose which beat.
3. **A whistle is found by its trill.** Its tone is masked by vocal harmonics in the same band,
   but its level flutters at about 28 Hz; sung notes do not.
4. **Cues must be foreign to the music**: each band against its own habits and against the
   seconds around it. A melody note recurring every bar otherwise forms a perfect "workout".
5. **A grid can hide in its multiples**: a 15 s grid contains every boundary of a 30 s one, and
   mid-interval sounds (a whoosh before a countdown) can favor it. Double, triple, half and third
   cycles are always scored; empty boundaries cost.
6. **Volume is imprecise**: a drop may come 1–2 s after the whistle. As timing evidence it pulled
   rest starts late; as wide support it helps.
7. **Rejection rules must hold on real music.** Rejecting grids that leave strong cues unexplained
   threw out 20 real tracks (sung notes are as strong as whistles); only support and volume
   contradictions remain.

Previous lessons that still hold: whisper runs in 10 s chunks with a two-window refinement of
command words, without temperature fallback and with repetition loops removed; carrying boundaries
over between tracks spreads one track's errors to all others.

## Findings that shape the next phases

1. **Shared production sounds.** Tracks of the same mixtape share identical audio: *Despacito*
   and *Burn* match on their first 10 s and on short snippets at offsets of multiples of 30 s
   (one 20 + 10 s cycle). Probably a common intro announcement and transition sounds.
   Phase 3 can use these recurring sounds as boundary evidence; phase 4 must decide matches
   by coverage and section consistency, never by hit counts alone.
2. **Spectral-change markers line up with interval boundaries** on real tracks (e.g. *Eye of
   the Tiger*: 10, 30, 70, 100, 120 s), while frame energy alone shows only a few dB of
   work/rest contrast.
3. **Embedded BPM tags are not reliable ground truth** (see *Burn*); interval labels for the
   corpus have to be made by hand (planned for phase 3).
4. This ffmpeg build has no SoX resampler; decoding uses ffmpeg's own windowed-sinc resampler
   (`filter_size=64`), which is part of every build.
