// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FfmpegDecoder } from '../decode/decoder.ts';
import { FfprobeMetadataReader } from '../decode/metadata.ts';
import type { Correction, IntervalType, WorkoutStructure } from '@tabata-sync/contracts';
import { IntervalTypeSchema } from '@tabata-sync/contracts';
import { applyCorrections, compareWithCorrected } from '../intervals/corrections.ts';
import { WhisperCppRecognizer } from '../speech/speech.ts';
import { extractFeatures } from '../dsp/features.ts';
import { alignFingerprints } from '../fingerprint/align.ts';
import { extractFingerprint } from '../fingerprint/landmarks.ts';
import { DEFAULT_INTERVAL_PARAMS, resolveParams } from '../pipeline/params.ts';
import { AnalysisPipeline } from '../pipeline/pipeline.ts';
import { AnalysisStore } from '../store/analysis-store.ts';
import { openDatabase } from '../store/database.ts';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.mp4', '.ogg', '.oga', '.opus']);

const USAGE = `Usage: tabata <command> [options]

Commands:
  analyze <file|folder>...   Analyze audio files, then detect workout intervals
  list                       List analyzed tracks
  show <file>                Show the stored analysis of a file
  intervals <file>           Show the workout (automatic result with corrections applied)
  correct <file> <action>    Add a manual correction (times in seconds):
                               move <from> <to> | add <at> <type> | remove <at>
                               type <at> <type> | range <start> <end> | countdown <at> <duration>
                             or label the whole workout, replacing all earlier labels:
                               label <work> <recovery> <work> ... <end>   (alternating, from work)
                               grid <start> <work-sec> <recovery-sec> <rounds>
  corrections <file>         List corrections and compare them with the automatic result
  compare <query> <reference>  Align two files by fingerprint (no database)

Options:
  --db <path>                Database file (default: $TABATA_DB or data/tabata.db)
  --force                    Re-analyze even if an identical analysis exists
  --marker-interval <sec>    Regular marker interval (default: 2)
  --no-speech                Skip speech recognition (whisper.cpp) during analysis
  --json                     Print machine-readable JSON
`;

async function collectAudioFiles(inputs: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const path = resolve(input);
    if ((await stat(path)).isDirectory()) {
      const entries = await readdir(path, { recursive: true });
      for (const entry of entries.sort()) {
        if (AUDIO_EXTENSIONS.has(extname(entry).toLowerCase())) files.push(join(path, entry));
      }
    } else {
      files.push(path);
    }
  }
  return files;
}

function formatDuration(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      force: { type: 'boolean', default: false },
      'marker-interval': { type: 'string' },
      json: { type: 'boolean', default: false },
      'no-speech': { type: 'boolean', default: false },
      author: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }

  const markerInterval = values['marker-interval'] ? Number(values['marker-interval']) : undefined;
  const params = resolveParams(markerInterval ? { markers: { regularIntervalSec: markerInterval } } : {});
  const dbPath = resolve(values.db ?? process.env.TABATA_DB ?? 'data/tabata.db');
  const print = (text: string) => process.stdout.write(`${text}\n`);

  switch (command) {
    case 'analyze': {
      const files = await collectAudioFiles(args);
      if (files.length === 0) throw new Error('No audio files found');
      const store = new AnalysisStore(openDatabase(dbPath));
      const pipeline = createPipeline(store, params, values);
      let failures = 0;
      const variants: Array<{ variantId: string; filename: string }> = [];
      for (const [index, file] of files.entries()) {
        try {
          const report = await pipeline.analyzeFile(file, { force: values.force });
          variants.push({ variantId: report.variantId, filename: report.metadata.filename });
          if (values.json) {
            print(JSON.stringify(report));
          } else {
            const tagged = report.metadata.taggedBpm ? ` (tag ${report.metadata.taggedBpm})` : '';
            const significant = Object.entries(report.markers)
              .filter(([type]) => type !== 'regular')
              .reduce((sum, [, count]) => sum + count, 0);
            const total = Object.values(report.timingsMs).reduce((a, b) => a + b, 0);
            print(
              `[${index + 1}/${files.length}] ${report.metadata.filename}: ${formatDuration(report.metadata.durationSec)}, ` +
                `${report.bpm.toFixed(1)} BPM${tagged} conf ${report.bpmConfidence.toFixed(2)}, ${report.beatCount} beats, ` +
                `${report.fingerprintHashes} hashes, ${report.markers.regular ?? 0} regular / ${significant} significant markers, ` +
                `${report.speechSegments} speech segments` +
                (report.reused ? ', reused earlier analysis' : `, ${total} ms`),
            );
          }
        } catch (error) {
          failures++;
          process.stderr.write(`[${index + 1}/${files.length}] ${file}: analysis failed: ${(error as Error).message}\n`);
        }
      }
      for (const { variantId, filename } of variants) {
        try {
          const report = await pipeline.detectIntervals(variantId, { force: values.force });
          if (values.json) print(JSON.stringify({ variantId, intervals: report }));
          else print(`${filename}: ${summarizeWorkout(report.structure)}${report.reused ? ' (reused)' : ''}`);
        } catch (error) {
          failures++;
          process.stderr.write(`${filename}: interval detection failed: ${(error as Error).message}\n`);
        }
      }
      return failures > 0 ? 1 : 0;
    }

    case 'intervals': {
      const { store, variantId, trackId, durationSec } = await resolveFile(dbPath, args[0]);
      const automatic = latestWorkout(store, variantId);
      const { structure, unmatched } = applyCorrections(automatic, store.corrections(trackId).map((c) => c.correction), durationSec);
      if (values.json) {
        print(JSON.stringify({ structure, unmatchedCorrections: unmatched }, null, 2));
        return 0;
      }
      print(summarizeWorkout(structure));
      for (const i of structure.intervals) {
        const label = `${i.type}${i.round ? ` ${i.round}` : ''}`.padEnd(12);
        const flags = [i.source === 'manual' ? 'manual' : '', i.deviation ? `deviation: ${i.deviation.reason}` : ''].filter(Boolean).join(', ');
        print(
          `${formatTime(i.startSec)}–${formatTime(i.endSec)}  ${label} ${(i.endSec - i.startSec).toFixed(1).padStart(6)} s  ` +
            `conf ${i.confidence.toFixed(2)}  ${i.evidence.join(' ')}${flags ? `  [${flags}]` : ''}`,
        );
      }
      for (const c of unmatched) print(`Correction did not match the current analysis: ${JSON.stringify(c)}`);
      return 0;
    }

    case 'correct': {
      const [file, action, ...rest] = args;
      const { store, trackId } = await resolveFile(dbPath, file);
      const correction = parseCorrection(action, rest);
      const id = store.addCorrection(trackId, correction, values.author);
      print(`Stored correction ${id}: ${JSON.stringify(correction)}`);
      return 0;
    }

    case 'corrections': {
      const { store, variantId, trackId, durationSec } = await resolveFile(dbPath, args[0]);
      const corrections = store.corrections(trackId);
      const automatic = latestWorkout(store, variantId);
      const corrected = applyCorrections(automatic, corrections.map((c) => c.correction), durationSec).structure;
      const comparison = compareWithCorrected(automatic, corrected);
      if (values.json) {
        print(JSON.stringify({ corrections, comparison }, null, 2));
        return 0;
      }
      for (const c of corrections) print(`${c.createdAt}  ${JSON.stringify(c.correction)}`);
      const errors = comparison.matched.map((m) => Math.abs(m.errorMs));
      print(
        `Automatic vs corrected: ${comparison.matched.length} shared boundaries` +
          (errors.length ? `, mean error ${(errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(0)} ms, max ${Math.max(...errors).toFixed(0)} ms` : '') +
          `, ${comparison.matched.filter((m) => !m.typeAgrees).length} type changes, ` +
          `${comparison.missedByAutomatic.length} added, ${comparison.rejectedAutomatic.length} removed`,
      );
      return 0;
    }

    case 'list': {
      const store = new AnalysisStore(openDatabase(dbPath));
      const tracks = store.listTracks();
      if (values.json) print(JSON.stringify(tracks));
      else for (const t of tracks) print(`${t.variantId}  ${formatDuration(t.durationSec)}  ${t.bpm?.toFixed(1) ?? '  -  '} BPM  ${t.runStatus ?? 'not analyzed'}  ${t.title ?? t.path}`);
      return 0;
    }

    case 'show': {
      const [file] = args;
      if (!file) throw new Error('show needs a file');
      const store = new AnalysisStore(openDatabase(dbPath));
      const metadata = await new FfprobeMetadataReader().read(resolve(file));
      const audioFile = store.findAudioFileBySha(metadata.sha256);
      const variant = audioFile && store.variantForAudioFile(audioFile.id);
      const run = variant && store.latestSucceededRun(variant.id);
      if (!variant || !run) {
        print('This file has not been analyzed yet.');
        return 1;
      }
      const rhythm = store.loadRhythm(run.id);
      const markers = store.loadMarkers(run.id).filter((m) => m.kind === 'significant');
      const result = {
        variantId: variant.id,
        trackId: variant.trackId,
        runs: store.runs(variant.id),
        rhythm: rhythm && {
          bpm: rhythm.bpm,
          confidence: rhythm.confidence,
          alternatives: rhythm.alternatives,
          tempoSegments: rhythm.tempoSegments,
          firstBeats: Array.from(rhythm.beats.slice(0, 8), (t) => Number(t.toFixed(3))),
        },
        significantMarkers: markers.map((m) => ({
          timeSec: Number(m.timeSec.toFixed(2)),
          type: m.type,
          durationSec: m.durationSec,
          strength: m.features.strength,
          confidence: Number(m.confidence.toFixed(2)),
        })),
      };
      print(JSON.stringify(result, null, 2));
      return 0;
    }

    case 'compare': {
      const [queryPath, referencePath] = args;
      if (!queryPath || !referencePath) throw new Error('compare needs two files');
      const decoder = new FfmpegDecoder();
      const fingerprintOf = async (path: string) => {
        const audio = await decoder.decode(resolve(path), { sampleRate: params.analysisSampleRate });
        return extractFingerprint(extractFeatures(audio, params.features).spectrogram, params.fingerprint);
      };
      const [query, reference] = await Promise.all([fingerprintOf(queryPath), fingerprintOf(referencePath)]);
      const alignment = alignFingerprints(query, reference);
      print(alignment ? JSON.stringify(alignment, null, 2) : 'No consistent alignment found.');
      return 0;
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

function createPipeline(store: AnalysisStore, params: ReturnType<typeof resolveParams>, values: { 'no-speech'?: boolean }) {
  return new AnalysisPipeline({
    store,
    decoder: new FfmpegDecoder(),
    metadataReader: new FfprobeMetadataReader(),
    params,
    ...(values['no-speech'] ? {} : { speech: new WhisperCppRecognizer() }),
    intervalParams: {
      ...DEFAULT_INTERVAL_PARAMS,
      useSpeech: !values['no-speech'],
    },
  });
}

function formatTime(sec: number): string {
  // Round first, so 239.97 s prints as 4:00.0 and not 3:60.0.
  const tenths = Math.round(sec * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}

function summarizeWorkout(structure: WorkoutStructure): string {
  const p = structure.pattern;
  if (p.rounds === 0) return 'No regular workout found';
  const shape = p.regular && p.workSec && p.recoverySec ? `${p.rounds} × ${p.workSec.toFixed(1)} s work / ${p.recoverySec.toFixed(1)} s recovery` : `${p.rounds} work intervals (irregular)`;
  const span = structure.workoutStartSec !== undefined && structure.workoutEndSec !== undefined ? `, ${formatTime(structure.workoutStartSec)}–${formatTime(structure.workoutEndSec)}` : '';
  const deviations = structure.intervals.filter((i) => i.deviation).length;
  return `${shape}${span}, confidence ${structure.confidence.toFixed(2)}${deviations ? `, ${deviations} deviation(s)` : ''}`;
}

async function resolveFile(dbPath: string, file: string | undefined) {
  if (!file) throw new Error('A file is required');
  const store = new AnalysisStore(openDatabase(dbPath));
  const metadata = await new FfprobeMetadataReader().read(resolve(file));
  const audioFile = store.findAudioFileBySha(metadata.sha256);
  const variant = audioFile && store.variantForAudioFile(audioFile.id);
  if (!variant) throw new Error('This file has not been analyzed yet');
  return { store, variantId: variant.id, trackId: variant.trackId, durationSec: metadata.durationSec };
}

function latestWorkout(store: AnalysisStore, variantId: string): WorkoutStructure {
  const run = store.latestSucceededRun(variantId, 'intervals');
  const structure = run && store.loadWorkout(run.id);
  if (!structure) throw new Error('No interval detection for this file yet; run analyze first');
  return structure;
}

function parseCorrection(action: string | undefined, args: readonly string[]): Correction {
  const num = (k: number) => {
    const value = Number(args[k]);
    if (!Number.isFinite(value)) throw new Error(`Expected a number of seconds, got "${args[k] ?? ''}"`);
    return value;
  };
  const type = (k: number): IntervalType => IntervalTypeSchema.parse(args[k]);
  switch (action) {
    case 'move':
      return { action: 'move_boundary', fromSec: num(0), toSec: num(1) };
    case 'add':
      return { action: 'add_boundary', atSec: num(0), type: type(1) };
    case 'remove':
      return { action: 'remove_boundary', atSec: num(0) };
    case 'type':
      return { action: 'set_type', atSec: num(0), type: type(1) };
    case 'range':
      return { action: 'set_workout_range', startSec: num(0), endSec: num(1) };
    case 'countdown':
      return { action: 'mark_countdown', atSec: num(0), durationSec: num(1) };
    case 'label': {
      const times = args.map((_, k) => num(k));
      if (times.length < 2) throw new Error('label needs at least a work start and the workout end');
      return labelCorrection(times);
    }
    case 'grid': {
      const [start, work, recovery, rounds] = [num(0), num(1), num(2), num(3)];
      const times: number[] = [];
      for (let k = 0; k < rounds; k++) times.push(start + k * (work + recovery), start + k * (work + recovery) + work);
      return labelCorrection(times);
    }
    default:
      throw new Error(`Unknown correction "${action ?? ''}"; use move, add, remove, type, range, countdown, label or grid`);
  }
}

/** Alternating work and recovery starts; the last time ends the workout. */
function labelCorrection(times: readonly number[]): Correction {
  for (let k = 1; k < times.length; k++) {
    if ((times[k] as number) <= (times[k - 1] as number)) throw new Error('label times must increase');
  }
  const round = (t: number) => Math.round(t * 100) / 100;
  return {
    action: 'set_boundaries',
    boundaries: [
      { atSec: 0, type: 'warmup' },
      ...times.map((t, k) => ({ atSec: round(t), type: k === times.length - 1 ? ('cooldown' as const) : k % 2 === 0 ? ('work' as const) : ('recovery' as const) })),
    ],
  };
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  },
);
