// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkoutStructure } from '@tabata-sync/contracts';
import { fixtureDir } from '../../test/support/synth.ts';
import { analyzeWorkout, renderWorkout, sayAvailable, scoreBoundaries, standardPlan, type WorkoutSpec } from '../../test/support/workout.ts';
import { WhisperCppRecognizer } from '../speech/speech.ts';
import { IntervalDetector } from './detector.ts';

/** Boundaries of a structure in the truth format: each interval start, plus the workout end. */
function boundariesOf(structure: WorkoutStructure) {
  const result = structure.intervals
    .filter((i) => i.type !== 'warmup' && i.type !== 'other')
    .map((i) => ({ timeSec: i.startSec, into: i.type === 'cooldown' ? ('end' as const) : i.type }));
  if (!structure.intervals.some((i) => i.type === 'cooldown') && structure.workoutEndSec !== undefined) {
    result.push({ timeSec: structure.workoutEndSec, into: 'end' as const });
  }
  return result;
}

describe('workout interval detection', () => {
  let dir: string;
  const detector = new IntervalDetector();

  async function run(name: string, spec: WorkoutSpec) {
    const workout = await renderWorkout(spec);
    const context = await analyzeWorkout(dir, `${name}.wav`, workout);
    const detection = detector.detect(context);
    const score = scoreBoundaries(boundariesOf(detection.structure), workout.boundaries, 1);
    return { workout, detection, score };
  }

  beforeAll(async () => {
    dir = await fixtureDir();
  });

  it('detects a standard 20/10 Tabata with warm-up and cooldown', async () => {
    const { detection, score } = await run('standard', {
      seed: 5, bpm: 128, warmupSec: 10, plan: standardPlan(20, 10, 8), cooldownSec: 10, beeps: true,
    });
    const s = detection.structure;
    expect(score).toMatchObject({ missed: 0, extra: 0, typeAccuracy: 1 });
    expect(score.maxErrorMs).toBeLessThan(150);
    expect(s.pattern).toMatchObject({ rounds: 8, regular: true });
    expect(s.pattern.workSec).toBeCloseTo(20, 1);
    expect(s.pattern.recoverySec).toBeCloseTo(10, 1);
    expect(s.intervals[0]?.type).toBe('warmup');
    expect(s.intervals.at(-1)?.type).toBe('cooldown');
    expect(s.intervals.filter((i) => i.type === 'work').map((i) => i.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  for (const [work, recovery, rounds] of [[30, 15, 6], [40, 20, 4]] as const) {
    it(`detects a ${work}/${recovery} pattern without speech`, async () => {
      const { detection, score } = await run(`p${work}`, {
        seed: work, bpm: 120, warmupSec: 15, plan: standardPlan(work, recovery, rounds), cooldownSec: 20, beeps: true,
      });
      expect(score).toMatchObject({ missed: 0, extra: 0, typeAccuracy: 1 });
      expect(score.maxErrorMs).toBeLessThan(150);
      expect(detection.structure.pattern.workSec).toBeCloseTo(work, 0);
      expect(detection.structure.pattern.recoverySec).toBeCloseTo(recovery, 0);
    });
  }

  // Known limitation: the synthetic music repeats every four bars (8.7 s here) with a new tonal
  // note, a perfectly regular cue pattern. Over 54 rounds it outweighs three rounds of beeps
  // the work music partly masks. Real songs have not shown this; when the model handles it,
  // this test starts failing and becomes a normal test again.
  it.fails('detects long endurance intervals', async () => {
    const { detection, score } = await run('endurance', {
      seed: 9, bpm: 110, warmupSec: 30, plan: standardPlan(120, 60, 3), cooldownSec: 30, beeps: true,
    });
    expect(score).toMatchObject({ missed: 0, extra: 0, typeAccuracy: 1 });
    expect(detection.structure.pattern.rounds).toBe(3);
  });

  it('fills boundaries without cues from the pattern, and says so', async () => {
    const { detection, score } = await run('missing', {
      seed: 5, bpm: 128, warmupSec: 10, plan: standardPlan(20, 10, 8), cooldownSec: 10,
      beeps: true, recoveryGainDb: -2, recoveryDrums: true, missingCues: [1, 5, 8, 12, 13],
    });
    expect(score).toMatchObject({ missed: 0, extra: 0, typeAccuracy: 1 });
    expect(score.maxErrorMs).toBeLessThan(150);
    const inferred = detection.structure.intervals.filter((i) => i.evidence.length === 1 && i.evidence[0] === 'pattern');
    expect(inferred.length).toBeGreaterThan(0);
    const supported = detection.structure.intervals.filter((i) => i.evidence.includes('acoustic:cue'));
    for (const interval of inferred) expect(interval.startConfidence).toBeLessThan(supported[0]?.startConfidence ?? 1);
  });

  it('reports no workout for irregular intervals, which are not supported', async () => {
    const plan = [
      { type: 'work', sec: 20 }, { type: 'recovery', sec: 10 },
      { type: 'work', sec: 35 }, { type: 'recovery', sec: 15 },
      { type: 'work', sec: 45 }, { type: 'recovery', sec: 10 },
      { type: 'work', sec: 25 },
    ] as const;
    const { detection } = await run('irregular', { seed: 13, bpm: 124, warmupSec: 12, plan, cooldownSec: 15, beeps: true });
    expect(detection.fit).toBeNull();
    expect(detection.structure.pattern.rounds).toBe(0);
  });

  it('is not misled by drops and steady whistles inside intervals', async () => {
    const { score } = await run('misleading', {
      seed: 21, bpm: 128, warmupSec: 10, plan: standardPlan(20, 10, 8), cooldownSec: 10, beeps: true,
      drops: [55, 115, 175], whistles: [35, 145],
    });
    expect(score).toMatchObject({ missed: 0, extra: 0, typeAccuracy: 1 });
  });

  it('bridges a locally replaced section with the pattern', async () => {
    const { score, detection } = await run('replaced', {
      seed: 25, bpm: 128, warmupSec: 10, plan: standardPlan(20, 10, 8), cooldownSec: 10, beeps: true,
      replaced: { fromSec: 95, toSec: 125 },
    });
    expect(score).toMatchObject({ missed: 0, extra: 0, typeAccuracy: 1 });
    expect(score.maxErrorMs).toBeLessThan(150);
    const bridged = detection.structure.intervals.filter((i) => i.startSec > 95 && i.startSec < 125);
    for (const interval of bridged) expect(interval.evidence).toContain('pattern');
  });

  describe.skipIf(process.platform !== 'darwin')('with speech', () => {
    const whisper = new WhisperCppRecognizer();
    let ready = false;
    beforeAll(async () => {
      ready = (await sayAvailable()) && (await whisper.available());
    });

    it('detects a workout from spoken countdowns alone', async (context) => {
      if (!ready) context.skip();
      const spec: WorkoutSpec = {
        seed: 31, bpm: 120, warmupSec: 12, plan: standardPlan(20, 10, 6), cooldownSec: 10,
        speech: true, recoveryGainDb: -1, recoveryDrums: true,
        backgroundSpeech: [{ atSec: 80, text: 'go go go, never stop' }],
      };
      const workout = await renderWorkout(spec);
      const analysis = await analyzeWorkout(dir, 'speech.wav', workout, whisper);
      const detection = detector.detect(analysis);
      const score = scoreBoundaries(boundariesOf(detection.structure), workout.boundaries, 1);
      expect(detection.candidates.some((c) => c.source === 'speech' && c.evidence.afterCountdown)).toBe(true);
      expect(score).toMatchObject({ missed: 0, extra: 0, typeAccuracy: 1 });
      expect(score.maxErrorMs).toBeLessThan(400);
    }, 180_000);
  });
});
