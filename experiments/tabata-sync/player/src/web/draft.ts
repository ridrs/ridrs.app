// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IntervalType, WorkoutInterval, WorkoutStructure } from '@tabata-sync/contracts';

/** One boundary of a labeling in progress: the interval of `type` starts at `atSec`. */
export interface DraftBoundary {
  readonly atSec: number;
  readonly type: IntervalType;
}

/**
 * A mark moves the nearest boundary of the same type within this distance instead of adding one.
 * Same-type boundaries of a workout are a whole cycle apart, so a few seconds never confuse two.
 */
export const MARK_SNAP_SEC = 5;

const round2 = (sec: number) => Math.round(sec * 100) / 100;
const sorted = (draft: readonly DraftBoundary[]) => [...draft].sort((a, b) => a.atSec - b.atSec);

export function draftOf(structure: WorkoutStructure): DraftBoundary[] {
  return structure.intervals.map((i) => ({ atSec: i.startSec, type: i.type }));
}

/** Places a mark heard while listening: moves the nearby boundary of that type, or adds one. */
export function placeMark(draft: readonly DraftBoundary[], atSec: number, type: IntervalType): DraftBoundary[] {
  let nearest = -1;
  for (const [k, b] of draft.entries()) {
    if (b.type !== type || b.atSec === 0 || Math.abs(b.atSec - atSec) > MARK_SNAP_SEC) continue;
    if (nearest < 0 || Math.abs(b.atSec - atSec) < Math.abs((draft[nearest] as DraftBoundary).atSec - atSec)) nearest = k;
  }
  const mark = { atSec: round2(atSec), type };
  return sorted(nearest < 0 ? [...draft, mark] : draft.map((b, k) => (k === nearest ? mark : b)));
}

/**
 * A tap heard as "something changes here", without a type: it moves the nearest boundary within
 * the snap distance, or starts the other phase (work after warm-up or recovery, recovery after work).
 */
export function markChange(draft: readonly DraftBoundary[], atSec: number): DraftBoundary[] {
  let nearest = -1;
  for (const [k, b] of draft.entries()) {
    if (b.atSec === 0 || Math.abs(b.atSec - atSec) > MARK_SNAP_SEC) continue;
    if (nearest < 0 || Math.abs(b.atSec - atSec) < Math.abs((draft[nearest] as DraftBoundary).atSec - atSec)) nearest = k;
  }
  if (nearest >= 0) return moveBoundary(draft, nearest, atSec);
  const current = [...sorted(draft)].reverse().find((b) => b.atSec <= atSec)?.type;
  return sorted([...draft, { atSec: round2(atSec), type: current === 'work' ? 'recovery' : 'work' }]);
}

export function moveBoundary(draft: readonly DraftBoundary[], index: number, atSec: number): DraftBoundary[] {
  return sorted(draft.map((b, k) => (k === index ? { ...b, atSec: round2(Math.max(0, atSec)) } : b)));
}

export function retypeBoundary(draft: readonly DraftBoundary[], index: number, type: IntervalType): DraftBoundary[] {
  return draft.map((b, k) => (k === index ? { ...b, type } : b));
}

export function removeBoundary(draft: readonly DraftBoundary[], index: number): DraftBoundary[] {
  return draft.filter((_, k) => k !== index);
}

/** A regular workout: warm-up, `rounds` × work and recovery, the last recovery replaced by the cooldown. */
export function gridDraft(startSec: number, workSec: number, recoverySec: number, rounds: number): DraftBoundary[] {
  const draft: DraftBoundary[] = [{ atSec: 0, type: 'warmup' }];
  for (let k = 0; k < rounds; k++) {
    const start = startSec + k * (workSec + recoverySec);
    draft.push({ atSec: round2(start), type: 'work' }, { atSec: round2(start + workSec), type: k === rounds - 1 ? 'cooldown' : 'recovery' });
  }
  return draft;
}

/**
 * While tapping, the last change can only be heard as "rest starts"; with no work after it, it is
 * the cooldown.
 */
export function finalizeDraft(draft: readonly DraftBoundary[]): DraftBoundary[] {
  const result = sorted(draft);
  const last = result.at(-1);
  if (last?.type === 'recovery') result[result.length - 1] = { ...last, type: 'cooldown' };
  return result;
}

/** The workout a draft describes, merging neighbors of the same type like the saved correction will. */
export function structureOf(draft: readonly DraftBoundary[], durationSec: number): WorkoutStructure {
  const merged: DraftBoundary[] = [];
  for (const b of finalizeDraft(draft).filter((b) => b.atSec < durationSec)) {
    if (merged.at(-1)?.type !== b.type) merged.push(b);
  }
  if (merged.length === 0 || (merged[0] as DraftBoundary).atSec > 0) merged.unshift({ atSec: 0, type: 'warmup' });
  let round = 0;
  const intervals: WorkoutInterval[] = merged.map((b, k) => {
    if (b.type === 'work') round++;
    return {
      index: k,
      type: b.type,
      startSec: b.atSec,
      endSec: merged[k + 1]?.atSec ?? durationSec,
      ...(b.type === 'work' || b.type === 'recovery' ? { round: Math.max(1, round) } : {}),
      confidence: 1,
      startConfidence: 1,
      endConfidence: 1,
      evidence: ['manual'],
      source: 'manual',
    };
  });
  return { pattern: { rounds: round, regular: false, support: 1 }, confidence: 1, intervals };
}
