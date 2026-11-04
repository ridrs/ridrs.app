// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/decode/process.ts';
import { encodeWav } from '../../src/decode/wav.ts';

export { encodeWav };

/** Deterministic PRNG (mulberry32) so every fixture is reproducible from its seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TempoChange {
  readonly atSec: number;
  readonly bpm: number;
}

export interface TrackSpec {
  readonly seed: number;
  readonly durationSec: number;
  /** Constant tempo, or a tempo map whose first entry starts at 0. */
  readonly bpm: number | readonly TempoChange[];
  readonly sampleRate?: number;
  readonly gain?: number;
  /** Instrument groups to render; all by default. */
  readonly layers?: { readonly drums?: boolean; readonly pad?: boolean; readonly melody?: boolean };
  /** Skip peak normalization so that layer renders of one seed stay level-matched. */
  readonly raw?: boolean;
}

export interface SyntheticTrack {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly beats: number[];
}

const SCALE = [0, 2, 3, 5, 7, 8, 10]; // natural minor

function midiToHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

function beatTimes(spec: TrackSpec): number[] {
  const map = typeof spec.bpm === 'number' ? [{ atSec: 0, bpm: spec.bpm }] : spec.bpm;
  const beats: number[] = [];
  let t = 0;
  while (t < spec.durationSec) {
    beats.push(t);
    const current = [...map].reverse().find((change) => change.atSec <= t) ?? map[0];
    t += 60 / (current?.bpm ?? 120);
  }
  return beats;
}

/**
 * Renders a small electronic track: kick, snare, hi-hats, a chord pad and a plucked melody.
 * The seed picks key, progression and melody, so different seeds give musically similar but
 * acoustically unrelated tracks — the hard case for false-positive tests.
 */
export function renderTrack(spec: TrackSpec): SyntheticTrack {
  const sampleRate = spec.sampleRate ?? 22050;
  const rand = random(spec.seed);
  const out = new Float32Array(Math.round(spec.durationSec * sampleRate));
  const beats = beatTimes(spec);
  const key = 40 + Math.floor(rand() * 12);
  const progression = Array.from({ length: 4 }, () => Math.floor(rand() * SCALE.length));
  const melody = Array.from({ length: 32 }, () => Math.floor(rand() * SCALE.length * 2));
  const noise = random(spec.seed ^ 0x9e3779b9);

  const add = (start: number, length: number, fn: (t: number, i: number) => number) => {
    const s0 = Math.round(start * sampleRate);
    const n = Math.min(Math.round(length * sampleRate), out.length - s0);
    for (let i = 0; i < n; i++) out[s0 + i] = (out[s0 + i] as number) + fn(i / sampleRate, i);
  };
  const scaleNote = (degree: number) => key + 12 * Math.floor(degree / SCALE.length) + (SCALE[degree % SCALE.length] as number);

  beats.forEach((beat, index) => {
    const next = beats[index + 1] ?? beat + 0.5;
    const beatLength = next - beat;
    const drums = spec.layers?.drums ?? true;
    // Kick: pitch-swept sine on every beat.
    if (drums) add(beat, 0.25, (t) => 0.8 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (50 * t + 60 * (1 - Math.exp(-t * 30)) / 30)));
    // Snare on beats 2 and 4: noise burst plus a tone.
    if (drums && index % 2 === 1) {
      add(beat, 0.18, (t) => Math.exp(-t * 25) * (0.35 * (noise() * 2 - 1) + 0.2 * Math.sin(2 * Math.PI * 190 * t)));
    }
    // Hi-hats on eighths: differentiated noise for a high-pass character.
    for (const half of drums ? [0, 0.5] : []) {
      let previous = 0;
      add(beat + half * beatLength, 0.05, (t) => {
        const value = noise() * 2 - 1;
        const high = value - previous;
        previous = value;
        return 0.12 * Math.exp(-t * 80) * high;
      });
    }
    // Chord pad, one chord per bar of four beats.
    if ((spec.layers?.pad ?? true) && index % 4 === 0) {
      const root = progression[(index / 4) % progression.length] as number;
      const notes = [root, root + 2, root + 4].map((d) => midiToHz(scaleNote(d) + 12));
      const length = Math.min(4 * beatLength, spec.durationSec - beat);
      add(beat, length, (t) => {
        const envelope = Math.min(1, t * 8) * Math.min(1, (length - t) * 8);
        let value = 0;
        for (const hz of notes) {
          for (let h = 1; h <= 3; h++) value += Math.sin(2 * Math.PI * hz * h * t) / (h * 2);
        }
        return 0.05 * envelope * value;
      });
    }
    // Plucked melody on eighths.
    for (const half of (spec.layers?.melody ?? true) ? [0, 0.5] : []) {
      const hz = midiToHz(scaleNote((melody[(index * 2 + half * 2) % melody.length] as number) + 14));
      add(beat + half * beatLength, 0.3, (t) => {
        const envelope = Math.exp(-t * 9);
        return 0.12 * envelope * (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t));
      });
    }
  });

  const gain = spec.gain ?? 1;
  if (spec.raw) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * 0.4 * gain;
    return { samples: out, sampleRate, beats };
  }
  let peak = 0;
  for (const value of out) peak = Math.max(peak, Math.abs(value));
  const scale = peak > 0 ? (0.7 * gain) / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * scale;
  return { samples: out, sampleRate, beats };
}

export async function fixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tabata-sync-'));
}

export async function writeTrack(dir: string, name: string, track: SyntheticTrack): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, encodeWav(track.samples, track.sampleRate));
  return path;
}

/** Runs ffmpeg on a fixture: `ffmpeg -i input <args> output`. */
export async function transform(input: string, output: string, args: readonly string[]): Promise<string> {
  await runProcess('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', input, ...args, output]);
  return output;
}
