// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Interval detection on a local folder of real tracks, through the full pipeline (speech when
 * whisper.cpp is installed, cues shared across the library). Opt-in, like the other corpus test:
 *
 *   TABATA_CORPUS="/path/to/Tabata Songs" npm test -- corpus-intervals
 *
 * Without hand-made labels this checks consistency, not accuracy: a structure is reported for
 * every track, and tracks that announce their boundaries by speech must agree with it.
 */

import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FfmpegDecoder } from '../src/decode/decoder.ts';
import { FfprobeMetadataReader } from '../src/decode/metadata.ts';
import { DEFAULT_INTERVAL_PARAMS, resolveParams } from '../src/pipeline/params.ts';
import { AnalysisPipeline } from '../src/pipeline/pipeline.ts';
import { WhisperCppRecognizer } from '../src/speech/speech.ts';
import { AnalysisStore } from '../src/store/analysis-store.ts';
import { openDatabase } from '../src/store/database.ts';

const corpus = process.env.TABATA_CORPUS;

describe.skipIf(!corpus)('real corpus intervals', () => {
  it('finds a workout in every track, consistent with spoken commands', async () => {
    const files = (await readdir(corpus as string, { recursive: true }))
      .filter((f) => ['.flac', '.mp3', '.wav', '.m4a', '.ogg', '.opus'].includes(extname(f).toLowerCase()))
      .sort()
      .map((f) => join(corpus as string, f));
    const store = new AnalysisStore(openDatabase(process.env.TABATA_CORPUS_DB ?? ':memory:'));
    const pipeline = new AnalysisPipeline({
      store,
      decoder: new FfmpegDecoder(),
      metadataReader: new FfprobeMetadataReader(),
      params: resolveParams(),
      speech: new WhisperCppRecognizer(),
      intervalParams: DEFAULT_INTERVAL_PARAMS,
    });
    const variants: string[] = [];
    for (const file of files) variants.push((await pipeline.analyzeFile(file)).variantId);

    let agreeing = 0;
    let commands = 0;
    for (const variantId of variants) {
      const { structure, runId } = await pipeline.detectIntervals(variantId);
      expect(structure.pattern.rounds).toBeGreaterThan(0);
      // Every "... go" / "... stop" after a countdown should sit on a boundary of the right kind.
      const spoken = store.loadCandidates(runId).filter((c) => c.source === 'speech' && c.evidence.afterCountdown && (c.type === 'WorkStart' || c.type === 'RecoveryStart'));
      for (const c of spoken) {
        commands++;
        const kind = c.type === 'WorkStart' ? 'work' : 'recovery';
        const hit = structure.intervals.some(
          (i) => Math.abs(i.startSec - c.timeSec) < 0.75 && (i.type === kind || (kind === 'recovery' && i.type === 'cooldown')),
        );
        if (hit) agreeing++;
      }
    }
    console.info(`Spoken commands on a matching boundary: ${agreeing}/${commands}`);
    if (commands > 0) expect(agreeing / commands).toBeGreaterThanOrEqual(0.9);
  }, 3_600_000);
});
