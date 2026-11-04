// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fingerprintFile } from '../../test/support/analyze.ts';
import { fixtureDir, renderTrack, transform, writeTrack } from '../../test/support/synth.ts';
import { alignFingerprints, HashTable } from './align.ts';

const DURATION_SEC = 40;

interface Variant {
  readonly name: string;
  readonly file: string;
  readonly args: readonly string[];
  /** Expected `referenceTime = speed * variantTime + offset`. */
  readonly speed?: number;
  readonly offsetSec?: number;
  /** Speed changes by resampling also shift pitch. */
  readonly pitch?: number;
}

// Each entry is one common real-world modification of the reference track.
const VARIANTS: readonly Variant[] = [
  { name: 'identical copy', file: 'copy.wav', args: [] },
  { name: 'gain -12 dB', file: 'quiet.wav', args: ['-af', 'volume=-12dB'] },
  { name: 'loudness normalization', file: 'loudnorm.wav', args: ['-af', 'loudnorm=I=-14'] },
  { name: 'equalization', file: 'eq.wav', args: ['-af', 'equalizer=f=100:t=q:w=1:g=9,equalizer=f=3000:t=q:w=1:g=-9'] },
  { name: 'dynamic compression', file: 'compressed.wav', args: ['-af', 'acompressor=threshold=-25dB:ratio=8:attack=5:release=50:makeup=4'] },
  { name: 'MP3 128 kbit/s', file: 'lossy.mp3', args: ['-b:a', '128k'] },
  { name: 'AAC 96 kbit/s', file: 'lossy.m4a', args: ['-c:a', 'aac', '-b:a', '96k'] },
  { name: 'Opus 64 kbit/s', file: 'lossy.opus', args: ['-c:a', 'libopus', '-b:a', '64k'] },
  { name: 'resampled to 48 kHz', file: 'hires.wav', args: ['-ar', '48000'] },
  { name: 'resampled to 16 kHz', file: 'lores.wav', args: ['-ar', '16000'] },
  { name: 'added noise', file: 'noisy.wav', args: ['-filter_complex', 'anoisesrc=a=0.03:c=pink:seed=7[n];[0][n]amix=inputs=2:duration=first:normalize=0'] },
  { name: '3 s leading silence', file: 'silence.wav', args: ['-af', 'adelay=3000'], offsetSec: -3 },
  { name: 'first 5 s removed', file: 'trimmed.wav', args: ['-ss', '5'], offsetSec: 5 },
  { name: 'tempo +3 % (pitch kept)', file: 'faster.wav', args: ['-af', 'atempo=1.03'], speed: 1.03 },
  { name: 'tempo -2 % (pitch kept)', file: 'slower.wav', args: ['-af', 'atempo=0.98'], speed: 0.98 },
  {
    name: 'speed +2 % by resampling (pitch shifted)',
    file: 'resampled-fast.wav',
    args: ['-af', 'asetrate=22050*1.02,aresample=22050'],
    speed: 1.02,
    pitch: 1.02,
  },
];

describe('landmark fingerprint', () => {
  let dir: string;
  let reference: HashTable;
  let referencePath: string;

  beforeAll(async () => {
    dir = await fixtureDir();
    referencePath = await writeTrack(dir, 'reference.wav', renderTrack({ seed: 1, bpm: 128, durationSec: DURATION_SEC }));
    reference = new HashTable((await fingerprintFile(referencePath)).fingerprint);
  });

  it('produces a dense, deterministic fingerprint', async () => {
    const again = await fingerprintFile(referencePath);
    expect(again.fingerprint.hashes).toEqual(reference.fingerprint.hashes);
    expect(reference.fingerprint.hashes.length / DURATION_SEC).toBeGreaterThan(100);
  });

  for (const variant of VARIANTS) {
    it(`recognizes the track after: ${variant.name}`, async () => {
      const path = await transform(referencePath, join(dir, variant.file), variant.args);
      const { fingerprint } = await fingerprintFile(path);
      const alignment = alignFingerprints(fingerprint, reference);

      expect(alignment).not.toBeNull();
      if (!alignment) return;
      console.info(`${variant.name}: similarity ${alignment.similarity.toFixed(3)}, offset ${(alignment.offsetSec * 1000).toFixed(1)} ms, speed ${alignment.speedRatio.toFixed(4)}`);
      expect(alignment.similarity).toBeGreaterThan(0.25);
      // `variantTime * speed + offset = referenceTime`.
      expect(alignment.speedRatio).toBeCloseTo(variant.speed ?? 1, 2);
      expect(Math.abs(alignment.offsetSec - (variant.offsetSec ?? 0))).toBeLessThan(0.03);
      expect(alignment.pitchRatio).toBeCloseTo(variant.pitch ?? 1, 1);
    });
  }

  it('keeps unrelated tracks with the same tempo and style apart', async () => {
    const scores: number[] = [];
    for (const seed of [2, 3, 4, 5]) {
      const path = await writeTrack(dir, `unrelated-${seed}.wav`, renderTrack({ seed, bpm: 128, durationSec: DURATION_SEC }));
      const alignment = alignFingerprints((await fingerprintFile(path)).fingerprint, reference);
      scores.push(alignment?.similarity ?? 0);
    }
    const genuine = alignFingerprints((await fingerprintFile(referencePath)).fingerprint, reference);
    expect(Math.max(...scores)).toBeLessThan(0.03);
    expect(genuine?.similarity ?? 0).toBeGreaterThan(10 * Math.max(...scores, 0.001));
  });
});
