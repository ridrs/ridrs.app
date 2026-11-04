// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it } from 'vitest';
import type { Correction, WorkoutStructure } from '@tabata-sync/contracts';
import { FfmpegDecoder } from '../decode/decoder.ts';
import { FfprobeMetadataReader } from '../decode/metadata.ts';
import { DEFAULT_INTERVAL_PARAMS, resolveParams } from '../pipeline/params.ts';
import { AnalysisPipeline } from '../pipeline/pipeline.ts';
import { AnalysisStore } from '../store/analysis-store.ts';
import { openDatabase } from '../store/database.ts';
import { fixtureDir, writeTrack } from '../../test/support/synth.ts';
import { renderWorkout, standardPlan } from '../../test/support/workout.ts';
import { applyCorrections, compareWithCorrected } from './corrections.ts';

describe('manual corrections', () => {
  let path: string;

  beforeAll(async () => {
    const dir = await fixtureDir();
    const workout = await renderWorkout({ seed: 41, bpm: 128, warmupSec: 10, plan: standardPlan(20, 10, 4), cooldownSec: 10, beeps: true });
    path = await writeTrack(dir, 'corrections.wav', { samples: workout.samples, sampleRate: workout.sampleRate, beats: [] });
  });

  function pipelineFor(store: AnalysisStore) {
    return new AnalysisPipeline({
      store,
      decoder: new FfmpegDecoder(),
      metadataReader: new FfprobeMetadataReader(),
      params: resolveParams(),
      intervalParams: { ...DEFAULT_INTERVAL_PARAMS, useSpeech: false },
    });
  }

  const startOf = (structure: WorkoutStructure, type: string, round: number) =>
    structure.intervals.find((i) => i.type === type && i.round === round)?.startSec;

  it('survive re-analysis and stay separate from automatic results', async () => {
    const store = new AnalysisStore(openDatabase(':memory:'));
    const pipeline = pipelineFor(store);
    const report = await pipeline.analyzeFile(path);
    const first = await pipeline.detectIntervals(report.variantId);
    expect(first.structure.pattern.rounds).toBe(4);

    // The user disagrees: round 2 starts 0.5 s later, round 3's recovery is a cooldown-like walk,
    // and there is an extra boundary in round 4.
    store.addCorrection(report.trackId, { action: 'move_boundary', fromSec: 40, toSec: 40.5 }, 'tester');
    store.addCorrection(report.trackId, { action: 'set_type', atSec: 95, type: 'other' });
    store.addCorrection(report.trackId, { action: 'add_boundary', atSec: 110, type: 'recovery' });

    const corrected = () =>
      applyCorrections(
        store.loadWorkout(store.latestSucceededRun(report.variantId, 'intervals')?.id ?? '') as WorkoutStructure,
        store.corrections(report.trackId).map((c) => c.correction),
        report.metadata.durationSec,
      );
    const before = corrected();
    expect(before.unmatched).toEqual([]);
    expect(startOf(before.structure, 'work', 2)).toBe(40.5);
    expect(before.structure.intervals.find((i) => i.startSec <= 95 && i.endSec > 95)?.type).toBe('other');
    expect(before.structure.intervals.some((i) => i.startSec === 110 && i.type === 'recovery' && i.source === 'manual')).toBe(true);

    // Full re-analysis and re-detection with force: new automatic runs, same corrections.
    await pipeline.analyzeFile(path, { force: true });
    const second = await pipeline.detectIntervals(report.variantId, { force: true });
    expect(second.runId).not.toBe(first.runId);
    expect(store.runs(report.variantId).filter((r) => r.kind === 'intervals')).toHaveLength(2);
    // The automatic result itself is untouched by corrections.
    expect(startOf(second.structure, 'work', 2)).toBeCloseTo(40, 0);
    expect(second.structure.intervals.every((i) => i.source === 'automatic')).toBe(true);

    const after = corrected();
    expect(after.unmatched).toEqual([]);
    expect(after.structure.intervals.map((i) => [i.type, i.startSec.toFixed(1)])).toEqual(
      before.structure.intervals.map((i) => [i.type, i.startSec.toFixed(1)]),
    );
  }, 120_000);

  it('compares automatic and corrected results as reference data', () => {
    const automatic: WorkoutStructure = {
      pattern: { rounds: 1, regular: false, support: 1 },
      confidence: 0.9,
      intervals: [
        { index: 0, type: 'warmup', startSec: 0, endSec: 10, confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' },
        { index: 1, type: 'work', startSec: 10, endSec: 30.4, round: 1, confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' },
        { index: 2, type: 'cooldown', startSec: 30.4, endSec: 40, confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' },
      ],
    };
    const { structure } = applyCorrections(
      automatic,
      [
        { action: 'move_boundary', fromSec: 30.4, toSec: 30 },
        { action: 'add_boundary', atSec: 20, type: 'recovery' },
      ],
      40,
    );
    const comparison = compareWithCorrected(automatic, structure);
    expect(comparison.matched.find((m) => m.correctedSec === 30)?.errorMs).toBeCloseTo(400, 0);
    expect(comparison.missedByAutomatic).toEqual([20]);
    expect(comparison.rejectedAutomatic).toEqual([]);
  });

  it('replaces every earlier boundary with a complete labeling', () => {
    const automatic: WorkoutStructure = {
      pattern: { cycleSec: 30.4, workSec: 24.2, recoverySec: 6.2, rounds: 2, regular: true, support: 1 },
      confidence: 0.9,
      intervals: [
        { index: 0, type: 'warmup', startSec: 0, endSec: 8, confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' },
        { index: 1, type: 'work', startSec: 8, endSec: 32.2, round: 1, confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' },
        { index: 2, type: 'recovery', startSec: 32.2, endSec: 38.4, round: 1, confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' },
        { index: 3, type: 'work', startSec: 38.4, endSec: 70, round: 2, confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' },
      ],
    };
    const label = (shift: number): Correction => ({
      action: 'set_boundaries',
      boundaries: [
        { atSec: 0, type: 'warmup' },
        { atSec: 10 + shift, type: 'work' },
        { atSec: 30 + shift, type: 'recovery' },
        { atSec: 40 + shift, type: 'work' },
        { atSec: 60 + shift, type: 'cooldown' },
      ],
    });
    // A second labeling replaces the first one entirely.
    const { structure, unmatched } = applyCorrections(automatic, [{ action: 'add_boundary', atSec: 50, type: 'recovery' }, label(1), label(0)], 70);
    expect(unmatched).toEqual([]);
    expect(structure.intervals.map((i) => [i.type, i.startSec])).toEqual([
      ['warmup', 0],
      ['work', 10],
      ['recovery', 30],
      ['work', 40],
      ['cooldown', 60],
    ]);
    expect(structure.pattern).toMatchObject({ rounds: 2, workSec: 20, recoverySec: 10, regular: true });
    expect(compareWithCorrected(automatic, structure).missedByAutomatic).toEqual([10, 30, 40, 60]);
  });

  it('reports a correction whose boundary no longer exists', () => {
    const automatic: WorkoutStructure = {
      pattern: { rounds: 0, regular: false, support: 0 },
      confidence: 0,
      intervals: [{ index: 0, type: 'other', startSec: 0, endSec: 40, confidence: 0, startConfidence: 0, endConfidence: 0, evidence: [], source: 'automatic' }],
    };
    const result = applyCorrections(automatic, [{ action: 'remove_boundary', atSec: 25 }], 40);
    expect(result.unmatched).toHaveLength(1);
  });
});
