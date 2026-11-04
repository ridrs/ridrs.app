// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Evaluation against a local folder of real workout tracks. Opt-in, because the audio is
 * commercial and never part of the repository:
 *
 *   TABATA_CORPUS="/path/to/Tabata Songs" npm test -- corpus
 */

import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FingerprintData } from '@tabata-sync/contracts';
import { FfprobeMetadataReader } from '../src/decode/metadata.ts';
import { alignFingerprints, HashTable } from '../src/fingerprint/align.ts';
import { DEFAULT_PARAMS } from '../src/pipeline/params.ts';
import { analyzeRhythm } from '../src/rhythm/rhythm.ts';
import { fingerprintFile } from './support/analyze.ts';
import { fixtureDir, transform } from './support/synth.ts';

const corpus = process.env.TABATA_CORPUS;

interface CorpusTrack {
  readonly path: string;
  readonly name: string;
  readonly taggedBpm?: number;
  readonly detectedBpm: number;
  readonly fingerprint: FingerprintData;
}

describe.skipIf(!corpus)('real corpus', () => {
  const tracks: CorpusTrack[] = [];

  beforeAll(async () => {
    const entries = (await readdir(corpus as string, { recursive: true })).filter((entry) =>
      ['.flac', '.mp3', '.wav', '.m4a', '.ogg', '.opus'].includes(extname(entry).toLowerCase()),
    );
    const reader = new FfprobeMetadataReader();
    for (const entry of entries.sort()) {
      const path = join(corpus as string, entry);
      const [metadata, { features, fingerprint }] = await Promise.all([reader.read(path), fingerprintFile(path)]);
      tracks.push({
        path,
        name: metadata.tags.title ?? metadata.filename,
        taggedBpm: metadata.tags.bpm,
        detectedBpm: analyzeRhythm(features, DEFAULT_PARAMS.rhythm).bpm,
        fingerprint,
      });
    }
  }, 600_000);

  it('agrees with embedded BPM tags on at least 90 % of tagged tracks', () => {
    const tagged = tracks.filter((t) => t.taggedBpm);
    const agreeing = tagged.filter((t) => Math.abs((t.detectedBpm / (t.taggedBpm as number)) - 1) < 0.01);
    for (const t of tagged.filter((x) => !agreeing.includes(x))) {
      console.info(`BPM disagreement: ${t.name}: detected ${t.detectedBpm.toFixed(1)}, tag ${t.taggedBpm}`);
    }
    console.info(`BPM agreement: ${agreeing.length}/${tagged.length}`);
    expect(agreeing.length / tagged.length).toBeGreaterThanOrEqual(0.9);
  });

  it('never aligns two different tracks of the corpus with meaningful similarity', () => {
    let worst = { similarity: 0, pair: '' };
    for (const reference of tracks) {
      const table = new HashTable(reference.fingerprint);
      for (const query of tracks) {
        if (query === reference) continue;
        const similarity = alignFingerprints(query.fingerprint, table)?.similarity ?? 0;
        if (similarity > worst.similarity) worst = { similarity, pair: `${query.name} → ${reference.name}` };
      }
    }
    // Tracks of one mixtape may share announcer or transition sounds; those short shared parts
    // are real matches, so whole-track similarity, not mere hits, must stay low.
    console.info(`Highest impostor similarity: ${worst.similarity.toFixed(4)} (${worst.pair})`);
    expect(worst.similarity).toBeLessThan(0.02);
  }, 600_000);

  it('finds a modified real track among all corpus tracks', async () => {
    const original = tracks[0] as CorpusTrack;
    const dir = await fixtureDir();
    // Re-encoded at 128 kbit/s, 2 % faster, quieter, first 7 s of the faster output cut
    // (output-side `-ss` applies after `atempo`, so 7.14 s of the original are missing).
    const variant = await transform(original.path, join(dir, 'variant.mp3'), [
      '-ss',
      '7',
      '-af',
      'atempo=1.02,volume=-6dB',
      '-b:a',
      '128k',
    ]);
    const { fingerprint } = await fingerprintFile(variant);
    const ranked = tracks
      .map((track) => ({ track, alignment: alignFingerprints(fingerprint, track.fingerprint) }))
      .sort((a, b) => (b.alignment?.similarity ?? 0) - (a.alignment?.similarity ?? 0));
    const [best, runnerUp] = ranked;
    expect(best?.track).toBe(original);
    expect(best?.alignment?.speedRatio).toBeCloseTo(1.02, 3);
    expect(Math.abs((best?.alignment?.offsetSec ?? 0) - 7 * 1.02)).toBeLessThan(0.03);
    expect(best?.alignment?.similarity ?? 0).toBeGreaterThan(20 * Math.max(runnerUp?.alignment?.similarity ?? 0, 0.001));
  }, 120_000);
});
