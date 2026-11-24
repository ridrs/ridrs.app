// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildVideoTime, TIME_STEP, type TimedTrack } from './video-time.ts';

/*
 * Where a route's video needs in-between frames (plan `video-zwischenframes.md`, phase 1): a rider
 * slower than the camera sees `frameRate · riderSpeed / cameraSpeed` different frames per second,
 * since the video world shows the frame at the video time of the presented distance (ADR 0061).
 * The rider's speed is the steady speed of an easy ride on the route's gradient; where it would
 * show fewer than `target` frames per second, the video gets 2, 4 or 8 frames per frame.
 */

/** The rider and bicycle of the estimate: the physics plugins' defaults (75 kg + 10 kg). */
export interface RiderModel {
  /** kg, rider and bicycle. */
  readonly mass: number;
  /** m², drag area. */
  readonly cdA: number;
  /** Rolling resistance coefficient. */
  readonly crr: number;
  /** kg/m³. */
  readonly airDensity: number;
  /** Share of the rider's power that reaches the wheel. */
  readonly efficiency: number;
}

export const REFINEMENT_RIDER: RiderModel = Object.freeze({
  mass: 85,
  cdA: 0.32,
  crr: 0.004,
  airDensity: 1.225,
  efficiency: 1,
});

/** m/s² */
const GRAVITY = 9.81;

/** W of the plan by default: the lower end of an easy ride of 100–150 W. */
export const REFINEMENT_POWER = 100;
/** Frames per second the rider should see at least. */
export const REFINEMENT_TARGET = 30;
/** The factors a stretch can have, lowest first; the last one is the most. */
export const REFINEMENT_FACTORS: readonly number[] = [2, 4, 8];

/** m over which the gradient is measured, centred on the distance. */
const GRADIENT_BASE = 100;
/** The steepest gradient taken either way, as the video world's (`MAX_GRADIENT`). */
const MAX_GRADIENT = 0.25;
/** m/s below which the camera stands still: nothing to refine. */
const STILL = 0.5;
/** s: a gap between two needing stretches shorter than this is refined as well. */
const GAP = 2;
/** s: a stretch of one factor shorter than this takes its neighbour's higher factor. */
const SHORTEST = 3;
/** s each refined stretch reaches further either way. */
const PADDING = 0.5;

/**
 * The steady speed (m/s) at `power` W on `gradient` (rise over run): where the power at the wheel
 * equals gravity, rolling resistance and drag times the speed. The force grows with the speed
 * wherever the rider moves forward, so there is one such speed; bisection finds it.
 */
export function steadySpeed(
  power: number,
  gradient: number,
  rider: RiderModel = REFINEMENT_RIDER,
): number {
  const angle = Math.atan(gradient);
  const weight = rider.mass * GRAVITY;
  const resisting = weight * (Math.sin(angle) + rider.crr * Math.cos(angle));
  const drag = 0.5 * rider.airDensity * rider.cdA;
  const wheel = power * rider.efficiency;
  const surplus = (speed: number) => (resisting + drag * speed * speed) * speed - wheel;
  let low = 0;
  let high = 1;
  while (surplus(high) < 0 && high < 1000) high *= 2;
  for (let i = 0; i < 60; i += 1) {
    const middle = (low + high) / 2;
    if (surplus(middle) < 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** A track with an elevation at each point, m above sea level. */
export interface ElevatedTrack extends TimedTrack {
  readonly points: readonly { readonly time: number; readonly elevation: number }[];
  /**
   * m the elevation steps from point `i` to the next across a jump of the track, a cut of the
   * video or of the GPS (ADR 0063): road no one rode, so no climb. Absent without a jump.
   */
  readonly steps?: readonly number[];
}

/** The elevations a rider climbs: each point's, less the steps across jumps before it. */
function climbedElevations(track: ElevatedTrack): number[] {
  let stepped = 0;
  return track.points.map((point, i) => {
    stepped += i > 0 ? (track.steps?.[i - 1] ?? 0) : 0;
    return point.elevation - stepped;
  });
}

export interface RefinementInput {
  readonly track: ElevatedTrack;
  /** Frames per second of the video. */
  readonly frameRate: number;
  /** s into the video where the track starts (the control file's start frame). */
  readonly offset?: number;
  /** Video times (s) of the video's cuts: no refined stretch crosses one. */
  readonly cuts?: readonly number[];
  readonly power?: number;
  readonly target?: number;
  readonly rider?: RiderModel;
}

/** One sample of the video time, every `TIME_STEP` s: what a rider at the plan's power sees there. */
export interface RefinementSample {
  /** s into the video. */
  readonly time: number;
  /** m along the route. */
  readonly distance: number;
  /** m/s of the camera, and of the rider at the plan's power on the gradient there. */
  readonly cameraSpeed: number;
  readonly riderSpeed: number;
  readonly gradient: number;
  /** Frames per frame the rider needs to see `target` frames per second; 0 where the camera stands still. */
  readonly need: number;
  /** `need` as a factor: 1 for none, else the lowest of `REFINEMENT_FACTORS` that covers it, at most the last. */
  readonly factor: number;
}

/** A stretch of the video computed again with `factor` frames per frame, from `from` s to `to` s. */
export interface RefinedStretch {
  readonly from: number;
  readonly to: number;
  readonly factor: number;
}

export interface RefinementPlan {
  readonly samples: readonly RefinementSample[];
  readonly stretches: readonly RefinedStretch[];
  readonly summary: {
    /** Pairs of the video's frames within the stretches, and the frames to compute between them. */
    readonly framePairs: number;
    readonly inBetweenFrames: number;
    /** Share of the video's time that is refined, 0 to 1. */
    readonly refinedShare: number;
    /** The fewest frames per second a rider at the plan's power sees where the camera moves, before and after. */
    readonly lowestSeenBefore: number;
    readonly lowestSeenAfter: number;
  };
}

/** The climbed elevation (m) at `distance`, linear between the track's points. */
function elevationAt(
  distances: readonly number[],
  elevations: readonly number[],
  distance: number,
): number {
  if (distance <= (distances[0] ?? 0)) return elevations[0] ?? 0;
  let low = 0;
  let high = distances.length - 1;
  if (distance >= (distances[high] ?? 0)) return elevations[high] ?? 0;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((distances[middle] ?? 0) <= distance) low = middle;
    else high = middle;
  }
  const a = distances[low] ?? 0;
  const b = distances[high] ?? 0;
  const ea = elevations[low] ?? 0;
  const eb = elevations[high] ?? 0;
  return b > a ? ea + ((eb - ea) * (distance - a)) / (b - a) : ea;
}

/** The gradient over `GRADIENT_BASE` m centred on `distance`, shortened at the ends. */
function gradientAt(
  distances: readonly number[],
  elevations: readonly number[],
  distance: number,
): number {
  const length = distances.at(-1) ?? 0;
  const from = Math.max(0, distance - GRADIENT_BASE / 2);
  const to = Math.min(length, distance + GRADIENT_BASE / 2);
  if (to - from < 1) return 0;
  const gradient =
    (elevationAt(distances, elevations, to) - elevationAt(distances, elevations, from)) /
    (to - from);
  return Math.max(-MAX_GRADIENT, Math.min(MAX_GRADIENT, gradient));
}

function factorOf(need: number): number {
  if (need <= 1) return 1;
  return (
    REFINEMENT_FACTORS.find((factor) => factor >= need) ?? (REFINEMENT_FACTORS.at(-1) as number)
  );
}

/** A run of samples `[first, last]` of one factor. */
interface Run {
  first: number;
  last: number;
  factor: number;
}

/**
 * The stretches of a route's video to compute again with in-between frames, and what a rider at
 * `power` W then sees. Per sample of the video time: the camera's speed from the smoothed table
 * (ADR 0062), the rider's steady speed on the gradient there, the need and its factor. Then, between
 * two cuts: gaps shorter than `GAP` s are closed, runs shorter than `SHORTEST` s take their
 * neighbour's higher factor, and each region reaches `PADDING` s further, never onto a moment where
 * the camera stands still.
 */
export function planRefinement(input: RefinementInput): RefinementPlan {
  const { track, frameRate } = input;
  const offset = input.offset ?? 0;
  const power = input.power ?? REFINEMENT_POWER;
  const target = input.target ?? REFINEMENT_TARGET;
  const rider = input.rider ?? REFINEMENT_RIDER;
  const { distances } = buildVideoTime(track);
  const climbed = climbedElevations(track);
  const end = offset + (track.points.at(-1)?.time ?? 0);

  const samples: RefinementSample[] = distances.map((distance, i) => {
    const before = distances[Math.max(0, i - 1)] ?? distance;
    const after = distances[Math.min(distances.length - 1, i + 1)] ?? distance;
    const span = (Math.min(distances.length - 1, i + 1) - Math.max(0, i - 1)) * TIME_STEP;
    const cameraSpeed = span > 0 ? (after - before) / span : 0;
    const gradient = gradientAt(track.distances, climbed, distance);
    const riderSpeed = steadySpeed(power, gradient, rider);
    const need = cameraSpeed < STILL ? 0 : (target * cameraSpeed) / (frameRate * riderSpeed);
    return {
      time: offset + i * TIME_STEP,
      distance,
      cameraSpeed,
      riderSpeed,
      gradient,
      need,
      factor: factorOf(need),
    };
  });

  // The video between two cuts, as ranges of samples: a sample at a cut belongs to the part after it.
  const cuts = [...(input.cuts ?? [])]
    .filter((cut) => cut > offset && cut < end)
    .sort((a, b) => a - b);
  const parts: [number, number][] = [];
  let first = 0;
  for (const cut of cuts) {
    const last = samples.findIndex((sample) => sample.time >= cut) - 1;
    if (last >= first) parts.push([first, last]);
    first = last + 1;
  }
  if (first < samples.length) parts.push([first, samples.length - 1]);

  const stretches: RefinedStretch[] = [];
  for (const [from, to] of parts) {
    const factors = samples.slice(from, to + 1).map((sample) => sample.factor);
    const still = samples.slice(from, to + 1).map((sample) => sample.cameraSpeed < STILL);
    closeGaps(factors, still);
    const timeOf = (index: number) => samples[from + index]?.time ?? 0;
    const partStart = timeOf(0);
    const partEnd = samples[to + 1]?.time ?? end;
    for (const region of regions(factors)) {
      // The padding reaches neither past the part nor onto a sample where the camera stands still.
      const stillBefore = lastIndex(still, region.first, -1);
      const stillAfter = lastIndex(still, region.last, 1);
      const earliest = stillBefore < 0 ? partStart : timeOf(stillBefore) + TIME_STEP;
      const latest = stillAfter < 0 ? partEnd : timeOf(stillAfter);
      const runs = mergeShort(splitByFactor(factors, region));
      runs.forEach((run, k) => {
        const start = k === 0 ? Math.max(earliest, timeOf(run.first) - PADDING) : timeOf(run.first);
        const stop =
          k === runs.length - 1
            ? Math.min(latest, timeOf(run.last) + TIME_STEP + PADDING)
            : timeOf(run.last) + TIME_STEP;
        stretches.push({ from: start, to: Math.min(stop, end), factor: run.factor });
      });
    }
  }

  // A stretch covers [from, to); the one that reaches the video's end covers its last moment too.
  const factorAt = (time: number) =>
    stretches.find((s) => time >= s.from && (time < s.to || (s.to === end && time === end)))
      ?.factor ?? 1;
  const moving = samples.filter((sample) => sample.cameraSpeed >= STILL);
  const seen = (sample: RefinementSample, factor: number) =>
    (frameRate * factor * sample.riderSpeed) / sample.cameraSpeed;
  const framePairs = stretches.reduce((sum, s) => sum + Math.round((s.to - s.from) * frameRate), 0);
  const inBetweenFrames = stretches.reduce(
    (sum, s) => sum + Math.round((s.to - s.from) * frameRate) * (s.factor - 1),
    0,
  );
  const refined = stretches.reduce((sum, s) => sum + (s.to - s.from), 0);
  return {
    samples,
    stretches,
    summary: {
      framePairs,
      inBetweenFrames,
      refinedShare: end > offset ? refined / (end - offset) : 0,
      lowestSeenBefore: Math.min(...moving.map((sample) => seen(sample, 1))),
      lowestSeenAfter: Math.min(...moving.map((sample) => seen(sample, factorAt(sample.time)))),
    },
  };
}

/** Fills a run of samples without need shorter than `GAP` s between two that need, with the lower factor. */
function closeGaps(factors: number[], still: readonly boolean[]): void {
  let lastNeed = -1;
  for (let i = 0; i < factors.length; i += 1) {
    if ((factors[i] ?? 1) < 2) continue;
    const gap = i - lastNeed - 1;
    if (
      lastNeed >= 0 &&
      gap > 0 &&
      gap * TIME_STEP < GAP &&
      !still.slice(lastNeed + 1, i).some(Boolean)
    ) {
      const fill = Math.min(factors[lastNeed] ?? 2, factors[i] ?? 2);
      for (let k = lastNeed + 1; k < i; k += 1) factors[k] = fill;
    }
    lastNeed = i;
  }
}

/** The runs of samples that need refining, whatever their factor. */
function regions(factors: readonly number[]): { first: number; last: number }[] {
  const found: { first: number; last: number }[] = [];
  for (let i = 0; i < factors.length; i += 1) {
    if ((factors[i] ?? 1) < 2) continue;
    const previous = found.at(-1);
    if (previous && previous.last === i - 1) previous.last = i;
    else found.push({ first: i, last: i });
  }
  return found;
}

function splitByFactor(factors: readonly number[], region: { first: number; last: number }): Run[] {
  const runs: Run[] = [];
  for (let i = region.first; i <= region.last; i += 1) {
    const factor = factors[i] ?? 2;
    const previous = runs.at(-1);
    if (previous && previous.factor === factor) previous.last = i;
    else runs.push({ first: i, last: i, factor });
  }
  return runs;
}

/** Joins each run shorter than `SHORTEST` s to its neighbour of the higher factor, shortest first. */
function mergeShort(runs: Run[]): Run[] {
  const length = (run: Run) => (run.last - run.first + 1) * TIME_STEP;
  for (;;) {
    const candidates = runs.filter((run) => length(run) < SHORTEST);
    if (runs.length < 2 || candidates.length === 0) return runs;
    const shortest = candidates.reduce((a, b) => (length(b) < length(a) ? b : a));
    const i = runs.indexOf(shortest);
    const left = runs[i - 1];
    const right = runs[i + 1];
    const into = !left ? right : !right ? left : left.factor >= right.factor ? left : right;
    if (!into) return runs;
    into.first = Math.min(into.first, shortest.first);
    into.last = Math.max(into.last, shortest.last);
    into.factor = Math.max(into.factor, shortest.factor);
    runs.splice(i, 1);
    // Neighbours of one factor become one run.
    for (let k = runs.length - 1; k > 0; k -= 1) {
      const a = runs[k - 1] as Run;
      const b = runs[k] as Run;
      if (a.factor === b.factor) {
        a.last = b.last;
        runs.splice(k, 1);
      }
    }
  }
}

/** The nearest index from `index` in `direction` (-1 or 1) whose flag is set, or -1. */
function lastIndex(flags: readonly boolean[], index: number, direction: -1 | 1): number {
  for (let i = index + direction; i >= 0 && i < flags.length; i += direction) {
    if (flags[i]) return i;
  }
  return -1;
}
