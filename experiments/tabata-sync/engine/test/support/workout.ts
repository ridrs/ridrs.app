// SPDX-License-Identifier: AGPL-3.0-or-later

import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IntervalType, SpeechSegment } from '@tabata-sync/contracts';
import { FfmpegDecoder } from '../../src/decode/decoder.ts';
import { runProcess } from '../../src/decode/process.ts';
import type { DetectionContext } from '../../src/intervals/detector.ts';
import { computeEvidenceCurves, EVIDENCE_SAMPLE_RATE } from '../../src/intervals/evidence.ts';
import { SPEECH_SAMPLE_RATE, type SpeechRecognizer } from '../../src/speech/speech.ts';
import { random, renderTrack, writeTrack } from './synth.ts';

export interface PlanStep {
  readonly type: 'work' | 'recovery';
  readonly sec: number;
}

export interface WorkoutSpec {
  readonly seed: number;
  readonly bpm: number;
  readonly warmupSec: number;
  readonly plan: readonly PlanStep[];
  readonly cooldownSec: number;
  /** Level of recovery sections relative to work, in dB. */
  readonly recoveryGainDb?: number;
  /** Keep drums in recovery sections (makes the contrast weaker). */
  readonly recoveryDrums?: boolean;
  /** Beep cues on boundaries; indices of boundaries listed in `missingCues` get none. */
  readonly beeps?: boolean;
  /** Trilled referee whistles on boundaries instead of beeps, quieter than the music around them. */
  readonly whistleCues?: boolean;
  readonly missingCues?: readonly number[];
  /** Spoken countdowns ("three, two, one, go" / "... stop"); the command starts on each boundary. */
  readonly speech?: boolean;
  /** Misleading events inside intervals. */
  readonly drops?: readonly number[];
  readonly whistles?: readonly number[];
  readonly backgroundSpeech?: ReadonlyArray<{ readonly atSec: number; readonly text: string }>;
  /** A section replaced by unrelated music without cues or contrast. */
  readonly replaced?: { readonly fromSec: number; readonly toSec: number };
}

export interface TruthBoundary {
  readonly timeSec: number;
  /** Type of the interval that starts here; `end` marks the workout end. */
  readonly into: 'work' | 'recovery' | 'end';
}

export interface SyntheticWorkout {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly durationSec: number;
  readonly boundaries: TruthBoundary[];
}

export function standardPlan(workSec: number, recoverySec: number, rounds: number, finalRecovery = false): PlanStep[] {
  const plan: PlanStep[] = [];
  for (let r = 0; r < rounds; r++) {
    plan.push({ type: 'work', sec: workSec });
    if (r < rounds - 1 || finalRecovery) plan.push({ type: 'recovery', sec: recoverySec });
  }
  return plan;
}

const SAMPLE_RATE = 22050;
const sayCache = new Map<string, Float32Array>();

export async function sayAvailable(): Promise<boolean> {
  try {
    await runProcess('say', ['-v', '?']);
    return true;
  } catch {
    return false;
  }
}

/** Speech from macOS `say`, trimmed of trailing silence, as mono samples. */
async function speak(text: string): Promise<Float32Array> {
  const cached = sayCache.get(text);
  if (cached) return cached;
  const dir = join(tmpdir(), 'tabata-sync-say');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${text.replace(/[^a-z0-9]+/gi, '-')}.aiff`);
  try {
    await access(file);
  } catch {
    await runProcess('say', ['-v', 'Samantha', '-r', '190', '-o', file, text]);
  }
  const audio = await new FfmpegDecoder().decode(file, { sampleRate: SAMPLE_RATE });
  let end = audio.samples.length;
  while (end > 0 && Math.abs(audio.samples[end - 1] as number) < 0.01) end--;
  const samples = audio.samples.slice(0, end);
  sayCache.set(text, samples);
  return samples;
}

/** Sample where the last word starts: after the last pause of at least 40 ms. */
function lastWordStart(voice: Float32Array): number {
  const pause = Math.round(0.04 * SAMPLE_RATE);
  let quiet = 0;
  for (let i = voice.length - 1; i >= 0; i--) {
    quiet = Math.abs(voice[i] as number) < 0.01 ? quiet + 1 : 0;
    if (quiet >= pause) return i + pause;
  }
  return 0;
}

function tone(out: Float32Array, atSec: number, hz: number, sec: number, gain: number): void {
  const start = Math.round(atSec * SAMPLE_RATE);
  for (let i = 0; i < sec * SAMPLE_RATE && start + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.min(1, t * 200) * Math.min(1, (sec - t) * 50);
    out[start + i] = (out[start + i] as number) + gain * envelope * Math.sin(2 * Math.PI * hz * t);
  }
}

/** A pea whistle: a 3.3 kHz tone whose level flutters at 28 Hz. */
function trilledWhistle(out: Float32Array, atSec: number, sec: number, gain: number): void {
  const start = Math.round(atSec * SAMPLE_RATE);
  for (let i = 0; i < sec * SAMPLE_RATE && start + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.min(1, t * 100) * Math.min(1, (sec - t) * 50) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 28 * t));
    out[start + i] = (out[start + i] as number) + gain * envelope * Math.sin(2 * Math.PI * (3300 + 60 * Math.sin(2 * Math.PI * 28 * t)) * t);
  }
}

function mix(out: Float32Array, samples: Float32Array, startSec: number, gain: number): void {
  const start = Math.round(startSec * SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) {
    if (start + i >= 0 && start + i < out.length) out[start + i] = (out[start + i] as number) + gain * (samples[i] as number);
  }
}

/**
 * Renders a workout with known boundaries: full mix during work, a quieter mix (optionally
 * without drums) during warm-up, recovery and cooldown, plus optional cues and distractions.
 */
export async function renderWorkout(spec: WorkoutSpec): Promise<SyntheticWorkout> {
  const total = spec.plan.reduce((s, p) => s + p.sec, 0);
  const durationSec = spec.warmupSec + total + spec.cooldownSec;
  const base = { seed: spec.seed, bpm: spec.bpm, durationSec, sampleRate: SAMPLE_RATE, raw: true };
  const full = renderTrack(base).samples;
  const calm = renderTrack({ ...base, layers: { drums: spec.recoveryDrums ?? false, pad: true, melody: true } }).samples;
  const out = new Float32Array(full.length);

  const boundaries: TruthBoundary[] = [];
  const sections: Array<{ from: number; to: number; work: boolean }> = [{ from: 0, to: spec.warmupSec, work: false }];
  let t = spec.warmupSec;
  for (const step of spec.plan) {
    boundaries.push({ timeSec: t, into: step.type });
    sections.push({ from: t, to: t + step.sec, work: step.type === 'work' });
    t += step.sec;
  }
  boundaries.push({ timeSec: t, into: 'end' });
  sections.push({ from: t, to: durationSec, work: false });

  const calmGain = 10 ** ((spec.recoveryGainDb ?? -6) / 20);
  const fade = Math.round(0.02 * SAMPLE_RATE);
  for (const section of sections) {
    const from = Math.round(section.from * SAMPLE_RATE);
    const to = Math.min(out.length, Math.round(section.to * SAMPLE_RATE));
    for (let i = from; i < to; i++) {
      const edge = Math.min(1, (i - from) / fade, (to - i) / fade);
      const work = (full[i] as number) * edge;
      const rest = (calm[i] as number) * calmGain * edge;
      out[i] = section.work ? work : rest;
    }
  }

  if (spec.replaced) {
    const other = renderTrack({ ...base, seed: spec.seed + 1000 }).samples;
    const from = Math.round(spec.replaced.fromSec * SAMPLE_RATE);
    const to = Math.round(spec.replaced.toSec * SAMPLE_RATE);
    for (let i = from; i < to; i++) out[i] = 0.7 * (other[i] as number);
  }

  const missing = new Set(spec.missingCues ?? []);
  for (const [k, boundary] of boundaries.entries()) {
    if (missing.has(k)) continue;
    if (spec.replaced && boundary.timeSec >= spec.replaced.fromSec && boundary.timeSec < spec.replaced.toSec) continue;
    if (spec.beeps) tone(out, boundary.timeSec, boundary.into === 'work' ? 1320 : 660, 0.35, 0.35);
    if (spec.whistleCues) trilledWhistle(out, boundary.timeSec, 0.4, 0.12);
    if (spec.speech) {
      const phrase = boundary.into === 'work' ? 'three, two, one, go!' : 'three, two, one, stop!';
      const voice = await speak(phrase);
      // Productions put the boundary where the command starts, on the beat.
      mix(out, voice, boundary.timeSec - lastWordStart(voice) / SAMPLE_RATE, 0.9);
    }
  }
  for (const at of spec.drops ?? []) {
    // A sudden one-second burst of extra drums: loud, but not a boundary.
    const burst = renderTrack({ ...base, seed: spec.seed + 7, layers: { drums: true, pad: false, melody: false } }).samples;
    const from = Math.round(at * SAMPLE_RATE);
    for (let i = from; i < from + SAMPLE_RATE && i < out.length; i++) out[i] = (out[i] as number) + 1.5 * (burst[i] as number);
  }
  for (const at of spec.whistles ?? []) tone(out, at, 2900, 0.3, 0.3);
  for (const line of spec.backgroundSpeech ?? []) mix(out, await speak(line.text), line.atSec, 0.5);

  // Gentle deterministic noise floor so that nothing is digitally silent.
  const noise = random(spec.seed ^ 0x51ed);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + 0.0005 * (noise() * 2 - 1);
  return { samples: out, sampleRate: SAMPLE_RATE, durationSec, boundaries };
}

/** A rendered workout written to disk and decoded like a real file, up to the detection context. */
export async function analyzeWorkout(dir: string, name: string, workout: SyntheticWorkout, speech?: SpeechRecognizer): Promise<DetectionContext> {
  const path = await writeTrack(dir, name, { samples: workout.samples, sampleRate: workout.sampleRate, beats: [] });
  const decoder = new FfmpegDecoder();
  const audio = await decoder.decode(path, { sampleRate: EVIDENCE_SAMPLE_RATE });
  let segments: SpeechSegment[] = [];
  if (speech) segments = await speech.transcribe(await decoder.decode(path, { sampleRate: SPEECH_SAMPLE_RATE }));
  return { durationSec: audio.durationSec, curves: computeEvidenceCurves(audio), speech: segments };
}

export interface BoundaryScore {
  readonly matched: number;
  readonly missed: number;
  readonly extra: number;
  readonly meanErrorMs: number;
  readonly maxErrorMs: number;
  readonly typeAccuracy: number;
}

/** Matches detected boundaries to the truth within `toleranceSec`, one-to-one. */
export function scoreBoundaries(
  detected: ReadonlyArray<{ timeSec: number; into: IntervalType | 'end' }>,
  truth: readonly TruthBoundary[],
  toleranceSec = 1,
): BoundaryScore {
  const used = new Set<number>();
  const errors: number[] = [];
  let typesRight = 0;
  for (const t of truth) {
    let best = -1;
    for (const [k, d] of detected.entries()) {
      if (used.has(k) || Math.abs(d.timeSec - t.timeSec) > toleranceSec) continue;
      if (best < 0 || Math.abs(d.timeSec - t.timeSec) < Math.abs((detected[best] as { timeSec: number }).timeSec - t.timeSec)) best = k;
    }
    if (best < 0) continue;
    used.add(best);
    const d = detected[best] as { timeSec: number; into: string };
    errors.push(Math.abs(d.timeSec - t.timeSec) * 1000);
    const into = d.into === 'cooldown' ? 'end' : d.into;
    if (into === t.into) typesRight++;
  }
  return {
    matched: errors.length,
    missed: truth.length - errors.length,
    extra: detected.length - used.size,
    meanErrorMs: errors.length ? errors.reduce((s, e) => s + e, 0) / errors.length : Number.POSITIVE_INFINITY,
    maxErrorMs: errors.length ? Math.max(...errors) : Number.POSITIVE_INFINITY,
    typeAccuracy: errors.length ? typesRight / errors.length : 0,
  };
}
