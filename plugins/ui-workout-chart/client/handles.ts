// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutInterval, WorkoutStep } from '@ridrs/contracts';

/**
 * The handles of the `edit` chart (structured-workouts.md, section 12): which edges of a step can
 * be dragged and what a drag makes of them. Pure, so that the snapping is tested without a DOM.
 */

/** A drag snaps to whole 15 s and to whole percent (or watts). */
export const SNAP_SECONDS = 15;
export const SNAP_POWER = 1;
/** The editor's limit (`validateWorkout`): a drag never goes beyond it. */
export const MAX_DRAG_PERCENT = 300;

export type HandleKind = 'duration' | 'power' | 'power-start' | 'power-end';

export function findInterval(steps: readonly WorkoutStep[], id: string): WorkoutInterval | undefined {
  for (const step of steps) {
    if (step.kind === 'interval') {
      if (step.id === id) return step;
    } else {
      const inner = findInterval(step.steps, id);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** The handles a step has: its end by time, and the top of a steady or ramp step by power. */
export function handlesOf(step: WorkoutInterval): readonly HandleKind[] {
  const handles: HandleKind[] = [];
  if (step.duration.kind === 'time') handles.push('duration');
  if (step.effort.kind !== 'target') return handles;
  const { primary } = step.effort;
  if (primary.unit !== 'percent-ftp' && primary.unit !== 'watts') return handles;
  const flat = (range: { low: number; high: number }) => range.low === range.high;
  if (!flat(primary.start) || (primary.end && !flat(primary.end))) return handles;
  handles.push(...(primary.end ? (['power-start', 'power-end'] as const) : (['power'] as const)));
  return handles;
}

/** The value a power handle sits at, in the unit of the step's target. */
export function powerOf(step: WorkoutInterval, handle: HandleKind): number | undefined {
  if (step.effort.kind !== 'target') return undefined;
  const { primary } = step.effort;
  return handle === 'power-end' ? (primary.end ?? primary.start).low : primary.start.low;
}

export const snap = (value: number, unit: number) => Math.round(value / unit) * unit;

/** The new length after dragging an end by `delta` seconds: whole 15 s, at least 15 s. */
export function draggedSeconds(from: number, delta: number): number {
  return Math.max(SNAP_SECONDS, snap(from + delta, SNAP_SECONDS));
}

/**
 * The new power after dragging a top edge by `delta` in the unit of the chart's axis, in the unit
 * of the step's target (whole percent or watts, from 0 to 300 %). A step in watts on a percent axis
 * (or the other way) needs the FTP to translate the movement; without it, nothing moves.
 */
export function draggedPower(
  from: number,
  delta: number,
  step: { axis: 'percent-ftp' | 'watts'; target: 'percent-ftp' | 'watts'; ftp?: number },
): number {
  let change = delta;
  if (step.axis !== step.target) {
    if (!step.ftp) return from;
    change = step.target === 'watts' ? (delta * step.ftp) / 100 : (delta * 100) / step.ftp;
  }
  const next = snap(from + change, SNAP_POWER);
  const limit = step.target === 'percent-ftp' ? MAX_DRAG_PERCENT : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, 0), limit);
}
