// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout } from '@ridrs/contracts';
import {
  type ChartShape,
  intensityContext,
  type PowerBasis,
  segmentIntensity,
  type WorkoutAthlete,
  workoutTimeline,
} from '@ridrs/workout';
import { durationText } from './describe.ts';
import type { Messages } from './i18n/index.ts';

/** What the tooltip says about a step. */
export interface StepInfo {
  readonly stepId: string;
  readonly title: string;
  readonly duration: string;
  /** "90 % FTP · 225 W"; the marker's words for a step without a power target. */
  readonly target: string;
  readonly zone?: string;
}

const round = (value: number) => Math.round(value);

/** A value or range in the axis unit, with its watts beside it when the FTP is known. */
function targetText(
  unit: PowerBasis,
  ftp: number | undefined,
  start: { low: number; high: number },
  end: { low: number; high: number },
  ramp: boolean,
  text: Messages,
): string {
  const form = (from: number, to: number) => (round(from) === round(to) ? `${round(from)}` : `${round(from)}–${round(to)}`);
  const mid = (r: { low: number; high: number }) => (r.low + r.high) / 2;
  const [from, to] = ramp ? [mid(start), mid(end)] : [start.low, start.high];
  if (unit === 'watts') return `${form(from, to)} W`;
  const percent = `${form(from, to)} % ${text.ftp}`;
  return ftp ? `${percent} · ${form((from * ftp) / 100, (to * ftp) / 100)} W` : percent;
}

/** The tooltip texts of every step of a workout, by step id's first appearance and position. */
export function stepInfos(
  workout: Workout,
  athlete: WorkoutAthlete,
  shapes: readonly ChartShape[],
  zoneNames: readonly (string | undefined)[],
  text: Messages,
): StepInfo[] {
  const timeline = workoutTimeline(workout);
  const context = intensityContext(workout, athlete);
  return shapes.map((shape, index) => {
    const segment = timeline.segments[shape.segmentIndex];
    if (!segment) return { stepId: shape.stepId, title: text.step(index + 1), duration: '', target: '' };
    const intensity = segmentIntensity(segment, context);
    const title =
      segment.name ?? (segment.intensity ? text.intensities[segment.intensity] : undefined) ?? text.step(index + 1);
    const marker = shape.marker === undefined ? undefined : text.markers[shape.marker];
    const target = targetText(context.basis, athlete.ftp, intensity.start, intensity.end, intensity.ramp, text);
    return {
      stepId: shape.stepId,
      title,
      duration: `${durationText(segment.durationSeconds)}${segment.estimated ? ` (${text.durationEstimated})` : ''}`,
      // A power target for an open length keeps its target; the rest has the marker's words only.
      target: marker === undefined ? target : intensity.power ? `${target} · ${marker}` : marker,
      ...(shape.zone === undefined ? {} : { zone: text.zone(shape.zone, zoneNames[shape.zone - 1]) }),
    };
  });
}
