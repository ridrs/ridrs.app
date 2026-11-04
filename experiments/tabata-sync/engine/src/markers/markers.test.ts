// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it } from 'vitest';
import type { AudioMarker } from '@tabata-sync/contracts';
import { FfmpegDecoder } from '../decode/decoder.ts';
import { extractFeatures } from '../dsp/features.ts';
import { extractFingerprint } from '../fingerprint/landmarks.ts';
import { DEFAULT_PARAMS, resolveParams } from '../pipeline/params.ts';
import { analyzeRhythm } from '../rhythm/rhythm.ts';
import { fixtureDir, renderTrack, writeTrack } from '../../test/support/synth.ts';
import { generateMarkers } from './markers.ts';

/**
 * 40 s of music: full level until 10 s, 12 dB quieter until 20 s, silence until 21 s,
 * full level again, and a loud whistle at 30 s.
 */
function structuredTrack(gain = 1) {
  const track = renderTrack({ seed: 7, bpm: 120, durationSec: 40 });
  const { samples, sampleRate } = track;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const level = t >= 20 && t < 21 ? 0 : t >= 10 && t < 20 ? 0.25 : 1;
    samples[i] = (samples[i] as number) * level * gain * 0.7;
  }
  const whistle = Math.round(30.25 * sampleRate);
  for (let i = 0; i < 0.15 * sampleRate; i++) {
    const t = i / sampleRate;
    samples[whistle + i] = (samples[whistle + i] as number) + gain * 0.6 * Math.sin(2 * Math.PI * 2800 * t) * Math.exp(-t * 20);
  }
  return track;
}

describe('audio markers', () => {
  const decoder = new FfmpegDecoder();
  let dir: string;

  async function markersOf(gain: number, params = DEFAULT_PARAMS) {
    const path = await writeTrack(dir, `structured-${gain}.wav`, structuredTrack(gain));
    const audio = await decoder.decode(path, { sampleRate: params.analysisSampleRate });
    const features = extractFeatures(audio, params.features);
    const fingerprint = extractFingerprint(features.spectrogram, params.fingerprint);
    return generateMarkers(features, fingerprint, analyzeRhythm(features, params.rhythm), params.markers);
  }

  const near = (markers: readonly AudioMarker[], types: readonly string[], timeSec: number, toleranceSec: number) =>
    markers.find((m) => types.includes(m.type) && Math.abs(m.timeSec - timeSec) <= toleranceSec);

  beforeAll(async () => {
    dir = await fixtureDir();
  });

  it('places regular markers on a configurable grid', async () => {
    const standard = await markersOf(1);
    expect(standard.regular.map((m) => m.timeSec).slice(0, 4)).toEqual([0, 2, 4, 6]);
    const dense = await markersOf(1, resolveParams({ markers: { regularIntervalSec: 1.5 } }));
    expect(dense.regular).toHaveLength(Math.ceil(40 / 1.5));
    for (const marker of dense.regular) {
      expect(marker.descriptor).toHaveLength(DEFAULT_PARAMS.features.melBands);
      expect(marker.hashes.length).toBeGreaterThan(0);
      expect(marker.relevance).toBeGreaterThanOrEqual(0);
      expect(marker.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('marks the volume drop, the pause, the return and the whistle', async () => {
    const { significant } = await markersOf(1);
    expect(near(significant, ['volume_decrease'], 10, 0.3)).toBeDefined();
    const pause = near(significant, ['pause'], 20, 0.2);
    expect(pause?.durationSec).toBeGreaterThan(0.8);
    expect(pause?.durationSec).toBeLessThan(1.2);
    expect(near(significant, ['volume_increase', 'drop'], 21, 0.3)).toBeDefined();
    expect(near(significant, ['transient'], 30.25, 0.05)).toBeDefined();
  });

  it('does not flood a steady groove with events', async () => {
    const { significant } = await markersOf(1);
    const transients = significant.filter((m) => m.type === 'transient');
    expect(transients.length).toBeLessThanOrEqual(3);
    expect(significant.length).toBeLessThan(20);
  });

  it('gives the same markers and descriptors after a gain change', async () => {
    const loud = await markersOf(1);
    const quiet = await markersOf(0.25);
    const types = (set: typeof loud) => set.significant.map((m) => `${m.type}@${Math.round(m.timeSec)}`);
    expect(types(quiet)).toEqual(types(loud));
    loud.regular.forEach((marker, i) => {
      const other = quiet.regular[i] as AudioMarker;
      const diffs = marker.descriptor.map((v, k) => Math.abs(v - (other.descriptor[k] as number)));
      // Silence windows have no stable spectrum; everything else must match closely.
      if (marker.features.relativeDb > -30) {
        expect(diffs.reduce((a, b) => a + b, 0) / diffs.length).toBeLessThan(0.3);
        expect(Math.max(...diffs)).toBeLessThan(1.5);
      }
    });
  });
});
