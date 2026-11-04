// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Correction, IntervalType, WorkoutInterval, WorkoutStructure } from '@tabata-sync/contracts';
import { median } from '../dsp/signal.ts';

/** A correction addresses the nearest boundary within this distance. */
export const BOUNDARY_TOLERANCE_SEC = 1.5;

interface Boundary {
  timeSec: number;
  /** Type of the interval that starts here. */
  type: IntervalType;
  manual: boolean;
  confidence: number;
  evidence: string[];
}

export interface AppliedCorrections {
  readonly structure: WorkoutStructure;
  /** Corrections that matched nothing, e.g. a boundary the new analysis no longer has. */
  readonly unmatched: Correction[];
}

function toBoundaries(structure: WorkoutStructure): Boundary[] {
  return structure.intervals.map((i) => ({
    timeSec: i.startSec,
    type: i.type,
    manual: i.source === 'manual',
    confidence: i.startConfidence,
    evidence: [...i.evidence],
  }));
}

function nearest(boundaries: readonly Boundary[], atSec: number): number {
  let best = -1;
  for (const [k, b] of boundaries.entries()) {
    if (k === 0 && b.timeSec === 0) continue; // track start is not a movable boundary
    if (Math.abs(b.timeSec - atSec) > BOUNDARY_TOLERANCE_SEC) continue;
    if (best < 0 || Math.abs(b.timeSec - atSec) < Math.abs((boundaries[best] as Boundary).timeSec - atSec)) best = k;
  }
  return best;
}

function rebuild(boundaries: Boundary[], durationSec: number, base: WorkoutStructure): WorkoutStructure {
  const sorted = boundaries.filter((b) => b.timeSec >= 0 && b.timeSec < durationSec).sort((a, b) => a.timeSec - b.timeSec);
  // Neighbors of the same type merge into one interval.
  const merged: Boundary[] = [];
  for (const b of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.type === b.type) {
      previous.manual ||= b.manual;
      continue;
    }
    merged.push(b);
  }
  if (merged.length === 0 || (merged[0] as Boundary).timeSec > 0) {
    merged.unshift({ timeSec: 0, type: 'warmup', manual: false, confidence: 1, evidence: [] });
  }

  let round = 0;
  const intervals: WorkoutInterval[] = merged.map((b, k) => {
    const end = (merged[k + 1] as Boundary | undefined)?.timeSec ?? durationSec;
    if (b.type === 'work') round++;
    const next = merged[k + 1];
    return {
      index: k,
      type: b.type,
      startSec: b.timeSec,
      endSec: end,
      ...(b.type === 'work' || b.type === 'recovery' ? { round: Math.max(1, round) } : {}),
      confidence: b.manual ? 1 : Math.min(b.confidence, next?.manual ? 1 : (next?.confidence ?? 1)),
      startConfidence: b.manual ? 1 : b.confidence,
      endConfidence: next ? (next.manual ? 1 : next.confidence) : 1,
      evidence: b.manual ? ['manual'] : b.evidence,
      source: b.manual ? 'manual' : 'automatic',
    };
  });

  const work = intervals.filter((i) => i.type === 'work');
  const recovery = intervals.filter((i) => i.type === 'recovery');
  const firstActive = intervals.find((i) => i.type === 'work' || i.type === 'recovery');
  const lastActive = [...intervals].reverse().find((i) => i.type === 'work' || i.type === 'recovery');
  return {
    ...base,
    pattern: intervals.some((i) => i.source === 'manual') ? patternOf(work, recovery) : { ...base.pattern, rounds: work.length },
    ...(firstActive ? { workoutStartSec: firstActive.startSec } : {}),
    ...(lastActive ? { workoutEndSec: lastActive.endSec } : {}),
    intervals,
  };
}

/** The pattern of corrected intervals: regular when every duration stays within the tolerance. */
function patternOf(work: readonly WorkoutInterval[], recovery: readonly WorkoutInterval[]): WorkoutStructure['pattern'] {
  if (work.length === 0) return { rounds: 0, regular: false, support: 1 };
  const length = (i: WorkoutInterval) => i.endSec - i.startSec;
  const workSec = median(work.map(length));
  const recoverySec = recovery.length > 0 ? median(recovery.map(length)) : undefined;
  const regular =
    recoverySec !== undefined &&
    work.every((i) => Math.abs(length(i) - workSec) <= BOUNDARY_TOLERANCE_SEC) &&
    recovery.every((i) => Math.abs(length(i) - recoverySec) <= BOUNDARY_TOLERANCE_SEC);
  return {
    ...(recoverySec !== undefined ? { cycleSec: workSec + recoverySec, recoverySec } : {}),
    workSec,
    rounds: work.length,
    regular,
    support: 1,
  };
}

/**
 * Overlays user corrections on an automatic result. Corrections address boundaries by time, not
 * by index, so they keep applying after re-analysis even if the automatic result changed.
 */
export function applyCorrections(structure: WorkoutStructure, corrections: readonly Correction[], durationSec: number): AppliedCorrections {
  let boundaries = toBoundaries(structure);
  const unmatched: Correction[] = [];
  for (const correction of corrections) {
    switch (correction.action) {
      case 'move_boundary': {
        const k = nearest(boundaries, correction.fromSec);
        if (k < 0) unmatched.push(correction);
        else Object.assign(boundaries[k] as Boundary, { timeSec: correction.toSec, manual: true });
        break;
      }
      case 'add_boundary': {
        const k = nearest(boundaries, correction.atSec);
        if (k >= 0 && Math.abs((boundaries[k] as Boundary).timeSec - correction.atSec) < 0.05) {
          Object.assign(boundaries[k] as Boundary, { type: correction.type, manual: true });
        } else {
          boundaries.push({ timeSec: correction.atSec, type: correction.type, manual: true, confidence: 1, evidence: ['manual'] });
        }
        break;
      }
      case 'remove_boundary': {
        const k = nearest(boundaries, correction.atSec);
        if (k < 0) unmatched.push(correction);
        else boundaries.splice(k, 1);
        break;
      }
      case 'set_type': {
        const sorted = [...boundaries].sort((a, b) => a.timeSec - b.timeSec);
        const containing = [...sorted].reverse().find((b) => b.timeSec <= correction.atSec);
        if (!containing) unmatched.push(correction);
        else Object.assign(containing, { type: correction.type, manual: true });
        break;
      }
      case 'set_workout_range': {
        // Everything before the start becomes warm-up, everything after the end cooldown.
        boundaries = boundaries.filter((b) => b.timeSec > correction.startSec + 0.05 && b.timeSec < correction.endSec - 0.05);
        const firstType = structure.intervals.find((i) => i.type === 'work' && i.endSec > correction.startSec)?.type ?? 'work';
        boundaries.push(
          { timeSec: 0, type: 'warmup', manual: true, confidence: 1, evidence: ['manual'] },
          { timeSec: correction.startSec, type: firstType, manual: true, confidence: 1, evidence: ['manual'] },
          { timeSec: correction.endSec, type: 'cooldown', manual: true, confidence: 1, evidence: ['manual'] },
        );
        break;
      }
      case 'set_boundaries':
        boundaries = correction.boundaries.map((b) => ({ timeSec: b.atSec, type: b.type, manual: true, confidence: 1, evidence: ['manual'] }));
        break;
      case 'mark_countdown':
        // Countdowns annotate the timeline; they do not change intervals.
        break;
    }
  }
  return { structure: rebuild(boundaries, durationSec, structure), unmatched };
}

export interface CorrectionComparison {
  /** Boundaries both results share, with the correction's time error of the automatic result. */
  readonly matched: Array<{ automaticSec: number; correctedSec: number; errorMs: number; typeAgrees: boolean }>;
  /** Boundaries the user added that the automatic result does not have. */
  readonly missedByAutomatic: number[];
  /** Automatic boundaries the user removed. */
  readonly rejectedAutomatic: number[];
}

/** Automatic result versus the corrected one, as reference data for algorithm work. */
export function compareWithCorrected(automatic: WorkoutStructure, corrected: WorkoutStructure): CorrectionComparison {
  const auto = automatic.intervals.filter((i) => i.startSec > 0);
  const fixed = corrected.intervals.filter((i) => i.startSec > 0);
  const used = new Set<number>();
  const matched: CorrectionComparison['matched'] = [];
  const missedByAutomatic: number[] = [];
  for (const c of fixed) {
    let best = -1;
    for (const [k, a] of auto.entries()) {
      if (used.has(k) || Math.abs(a.startSec - c.startSec) > BOUNDARY_TOLERANCE_SEC) continue;
      if (best < 0 || Math.abs(a.startSec - c.startSec) < Math.abs((auto[best] as WorkoutInterval).startSec - c.startSec)) best = k;
    }
    if (best < 0) {
      missedByAutomatic.push(c.startSec);
      continue;
    }
    used.add(best);
    const a = auto[best] as WorkoutInterval;
    matched.push({ automaticSec: a.startSec, correctedSec: c.startSec, errorMs: (a.startSec - c.startSec) * 1000, typeAgrees: a.type === c.type });
  }
  return { matched, missedByAutomatic, rejectedAutomatic: auto.filter((_, k) => !used.has(k)).map((a) => a.startSec) };
}
