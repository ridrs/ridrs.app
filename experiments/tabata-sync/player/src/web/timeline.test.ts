// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { WorkoutInterval, WorkoutStructure } from '@tabata-sync/contracts';
import { positionAt } from './timeline.ts';

function interval(index: number, type: WorkoutInterval['type'], startSec: number, endSec: number, round?: number): WorkoutInterval {
  return { index, type, startSec, endSec, ...(round ? { round } : {}), confidence: 1, startConfidence: 1, endConfidence: 1, evidence: [], source: 'automatic' };
}

const workout: WorkoutStructure = {
  pattern: { rounds: 2, regular: true, support: 1, workSec: 20, recoverySec: 10, cycleSec: 30 },
  workoutStartSec: 10,
  workoutEndSec: 60,
  confidence: 1,
  intervals: [
    interval(0, 'warmup', 0, 10),
    interval(1, 'work', 10, 30, 1),
    interval(2, 'recovery', 30, 40, 1),
    interval(3, 'work', 40, 60, 2),
    interval(4, 'cooldown', 60, 70),
  ],
};

describe('workout position', () => {
  it('reports the current interval, remaining time and the next interval', () => {
    const p = positionAt(workout, 32.5);
    expect(p.interval?.type).toBe('recovery');
    expect(p.remainingSec).toBeCloseTo(7.5);
    expect(p.next?.type).toBe('work');
    expect(p).toMatchObject({ round: 1, totalRounds: 2, completedRounds: 1 });
    expect(p.workoutProgress).toBeCloseTo(0.45);
  });

  it('is a pure function of the position, so seeking backwards and forwards is exact', () => {
    expect(positionAt(workout, 55).interval?.round).toBe(2);
    expect(positionAt(workout, 5)).toMatchObject({ round: 0, completedRounds: 0, workoutProgress: 0 });
    expect(positionAt(workout, 10).interval?.type).toBe('work');
    expect(positionAt(workout, 70).interval?.type).toBe('cooldown');
  });
});
