// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it } from 'vitest';
import { FfmpegDecoder } from '../decode/decoder.ts';
import { extractFeatures } from '../dsp/features.ts';
import { DEFAULT_PARAMS } from '../pipeline/params.ts';
import { fixtureDir, renderTrack, type TrackSpec, writeTrack } from '../../test/support/synth.ts';
import { analyzeRhythm } from './rhythm.ts';

const TOLERANCE_SEC = 0.07;

/** Share of reference beats with a detected beat within the tolerance, and vice versa (F-measure). */
function beatFMeasure(detected: ArrayLike<number>, reference: readonly number[]): number {
  const hits = (from: ArrayLike<number>, to: ArrayLike<number>) =>
    Array.from(from).filter((t) => Array.from(to).some((u) => Math.abs(t - u) <= TOLERANCE_SEC)).length;
  const precision = hits(detected, reference) / Math.max(1, detected.length);
  const recall = hits(reference, detected) / Math.max(1, reference.length);
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

describe('tempo and beat detection', () => {
  let dir: string;
  const decoder = new FfmpegDecoder();

  async function analyze(name: string, spec: TrackSpec) {
    const track = renderTrack(spec);
    const path = await writeTrack(dir, name, track);
    const audio = await decoder.decode(path, { sampleRate: DEFAULT_PARAMS.analysisSampleRate });
    return { track, rhythm: analyzeRhythm(extractFeatures(audio, DEFAULT_PARAMS.features), DEFAULT_PARAMS.rhythm) };
  }

  beforeAll(async () => {
    dir = await fixtureDir();
  });

  for (const bpm of [90, 128, 160]) {
    it(`finds ${bpm} BPM and its beats`, async () => {
      const { track, rhythm } = await analyze(`steady-${bpm}.wav`, { seed: bpm, bpm, durationSec: 40 });
      expect(Math.abs(rhythm.bpm - bpm)).toBeLessThan(0.5);
      expect(rhythm.tempoSegments).toHaveLength(1);
      expect(beatFMeasure(rhythm.beats, track.beats)).toBeGreaterThan(0.95);
      expect(rhythm.confidence).toBeGreaterThan(0.3);
    });
  }

  it('reports the half-time and double-time interpretations', async () => {
    const { rhythm } = await analyze('octaves.wav', { seed: 11, bpm: 140, durationSec: 30 });
    const half = rhythm.alternatives.find((c) => c.relation === 'half');
    const double = rhythm.alternatives.find((c) => c.relation === 'double');
    expect(half?.bpm).toBeCloseTo(70, 0);
    expect(double?.bpm).toBeCloseTo(280, 0);
  });

  it('keeps a tempo change instead of forcing one global value', async () => {
    const { track, rhythm } = await analyze('change.wav', {
      seed: 21,
      durationSec: 60,
      bpm: [
        { atSec: 0, bpm: 110 },
        { atSec: 30, bpm: 132 },
      ],
    });
    expect(rhythm.tempoSegments).toHaveLength(2);
    const [first, second] = rhythm.tempoSegments;
    expect(Math.abs((first?.bpm ?? 0) - 110)).toBeLessThan(1);
    expect(Math.abs((second?.bpm ?? 0) - 132)).toBeLessThan(1);
    expect(Math.abs((second?.startSec ?? 0) - 30)).toBeLessThan(4);
    expect(beatFMeasure(rhythm.beats, track.beats)).toBeGreaterThan(0.9);
  });

  it('survives a quieter recording without changing the result', async () => {
    const loud = await analyze('loud.wav', { seed: 31, bpm: 124, durationSec: 30 });
    const quiet = await analyze('quiet.wav', { seed: 31, bpm: 124, durationSec: 30, gain: 0.1 });
    expect(Math.abs(quiet.rhythm.bpm - loud.rhythm.bpm)).toBeLessThan(0.2);
  });
});
