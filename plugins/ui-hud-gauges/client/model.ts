// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ActivityState, HeartRateZones, PowerZones } from '@ridrs/contracts';
import { defaultHeartRateZones, defaultPowerZones, type TrainingZones } from '@ridrs/workout';

/** One zone on a gauge's scale, in the gauge's unit. */
export interface Band {
  /** 1-based, as the profile counts its zones. */
  readonly zone: number;
  readonly name?: string;
  /** Where the band starts and ends on the scale, rounded to whole units for display. */
  readonly from: number;
  readonly to: number;
  /** The exact upper bound of the zone; undefined for the last, open zone. */
  readonly limit: number | undefined;
  /** The colour of the zone, as the workout chart colours it. */
  readonly colour: string;
}

/** What a gauge draws: its range, its tick spacing and its zones (none: a neutral scale). */
export interface Scale {
  readonly min: number;
  readonly max: number;
  /** Ticks with a number. */
  readonly major: number;
  /** Ticks between them. */
  readonly minor: number;
  readonly bands: readonly Band[];
}

/**
 * The zone ramp of the workout chart (`ui-workout-chart/client/palette.ts`, dark theme), cool to
 * hot. Plugins share no code, so the gauges keep their own copy; the HUD lies over a video and is
 * always dark.
 */
const ZONE_COLOURS = [
  '#0a3aff',
  '#59a6cf',
  '#0ffae3',
  '#99db94',
  '#f5ff3d',
  '#d0a771',
  '#f68c14',
  '#fe2966',
  '#ff70e0',
  '#8b49fa',
] as const;

/** The colour of a 1-based zone, spreading `count` zones over the ramp as the chart does. */
export function zoneColour(zone: number, count: number): string {
  const slots = ZONE_COLOURS.length;
  const index = Math.min(Math.max(Math.round(zone), 1), Math.max(count, 1)) - 1;
  const slot =
    count > slots
      ? Math.min(index, slots - 1)
      : count <= 1
        ? 0
        : Math.round((index * (slots - 1)) / (Math.min(count, slots) - 1));
  return ZONE_COLOURS[slot] ?? ZONE_COLOURS[0];
}

const STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500] as const;

/** The smallest round step that splits `range` into at most `ticks` parts. */
function niceStep(range: number, ticks = 6): number {
  return STEPS.find((step) => range / step <= ticks) ?? 1000;
}

/** Minor ticks: five per major step where that stays round, else two. */
function minorOf(major: number): number {
  return major % 5 === 0 ? major / 5 : major / 2;
}

/**
 * The bands of `zones` whose upper bounds `toUnit` turns into the gauge's unit, from `min` to
 * `max`. A zone that ends below `min` is left out; the next one starts at `min`.
 */
function bandsOf(
  zones: TrainingZones,
  toUnit: (bound: number) => number,
  min: number,
  max: number,
): Band[] {
  const bands: Band[] = [];
  let from = min;
  zones.forEach((zone, index) => {
    const limit = zone.upTo === undefined ? undefined : toUnit(zone.upTo);
    const to = limit === undefined ? max : Math.min(Math.round(limit), max);
    if (to > from) {
      bands.push({
        zone: index + 1,
        ...(zone.name === undefined ? {} : { name: zone.name }),
        from,
        to,
        limit,
        colour: zoneColour(index + 1, zones.length),
      });
      from = to;
    }
  });
  return bands;
}

/** The highest bound of `zones` in the gauge's unit: where the last, open zone begins. */
function topBound(zones: TrainingZones, toUnit: (bound: number) => number): number | undefined {
  const bounds = zones.flatMap((zone) => (zone.upTo === undefined ? [] : [toUnit(zone.upTo)]));
  return bounds.length === 0 ? undefined : Math.max(...bounds);
}

/**
 * The power gauge: from 0 W to a round number above where the last zone begins, coloured by the
 * power zones (% FTP, Coggan's by default) in watts. Without an FTP there are no watts to colour.
 */
export function powerScale(ftp: number | undefined, zones: PowerZones | undefined): Scale {
  if (ftp === undefined) {
    return { min: 0, max: 600, major: 100, minor: 20, bands: [] };
  }
  const used = zones ?? defaultPowerZones();
  const toWatts = (percent: number) => (percent * ftp) / 100;
  const top = topBound(used, toWatts) ?? ftp;
  const reach = top * 1.15;
  const major = niceStep(reach);
  const max = Math.ceil(reach / major) * major;
  return { min: 0, max, major, minor: minorOf(major), bands: bandsOf(used, toWatts, 0, max) };
}

/**
 * The heart rate gauge: from a round number below the first bound to one above the last bound or
 * the maximum heart rate, coloured by the heart rate zones (bpm; Friel's of the LTHR by default).
 */
export function heartRateScale(
  zones: HeartRateZones | undefined,
  lthr: number | undefined,
  maxHeartRate: number | undefined,
): Scale {
  const used = zones ?? (lthr === undefined ? undefined : defaultHeartRateZones(lthr));
  const identity = (bpm: number) => bpm;
  const first = used?.[0]?.upTo;
  const top = used === undefined ? undefined : topBound(used, identity);
  if (used === undefined || first === undefined || top === undefined) {
    return { min: 60, max: 200, major: 20, minor: 5, bands: [] };
  }
  const min = Math.floor((first * 0.75) / 10) * 10;
  const reach = Math.max(maxHeartRate ?? 0, top + 10);
  const major = niceStep(reach - min);
  const max = min + Math.ceil((reach - min) / major) * major;
  return { min, max, major, minor: minorOf(major), bands: bandsOf(used, identity, min, max) };
}

/**
 * Cadence bands, upper bounds in rpm: the profile has no cadence zones, so the gauge shows fixed
 * bands around the usual 80 to 100 rpm of riding on a trainer.
 */
export const CADENCE_ZONES: TrainingZones = [{ upTo: 60 }, { upTo: 75 }, { upTo: 90 }, { upTo: 105 }, {}];

export function cadenceScale(): Scale {
  return { min: 0, max: 140, major: 20, minor: 5, bands: bandsOf(CADENCE_ZONES, (rpm) => rpm, 0, 140) };
}

/** The band a value lies in, by the exact bounds (inclusive, as `zoneOf`); none on a neutral scale. */
export function bandAt(scale: Scale, value: number): Band | undefined {
  return scale.bands.find((band) => band.limit === undefined || value <= band.limit) ?? scale.bands.at(-1);
}

/** The gauge's sweep: 240°, open at the bottom, clockwise from the lower left. */
export const START_ANGLE = 150;
export const SWEEP = 240;

/** The angle of `value` on the scale in degrees (0° points right, clockwise), held at the ends. */
export function angleOf(scale: Scale, value: number): number {
  const span = scale.max - scale.min;
  const fraction = span <= 0 ? 0 : Math.min(Math.max((value - scale.min) / span, 0), 1);
  return START_ANGLE + fraction * SWEEP;
}

/** The values of the scale that carry a tick, with whether it is a major one. */
export function ticksOf(scale: Scale): { readonly value: number; readonly major: boolean }[] {
  const ticks: { value: number; major: boolean }[] = [];
  const count = Math.round((scale.max - scale.min) / scale.minor);
  for (let index = 0; index <= count; index += 1) {
    const value = scale.min + index * scale.minor;
    ticks.push({ value, major: (value - scale.min) % scale.major === 0 });
  }
  return ticks;
}

/**
 * The average of a metric over the ride: the mean of the available readings published while the
 * ride runs. The bus's publish order (`seq`) decides: a reading counts when it was published after
 * the ride started or went on, so readings from before the ride, from a pause, or replayed to a
 * late subscriber do not count, and none counts twice. A new session starts from none. The bus
 * may hand a late subscriber the latest reading before the ride's state: the latest reading not
 * yet counted waits, and counts once the state shows it came after the start.
 */
export class RideAverage {
  private session: string | undefined;
  private runningSince: number | undefined;
  private lastSeq = 0;
  private sum = 0;
  private count = 0;
  private waiting: { readonly value: number | undefined; readonly seq: number } | undefined;

  activity(state: ActivityState, seq: number): void {
    if (state.state === 'idle') {
      this.runningSince = undefined;
      return;
    }
    if (state.sessionId !== this.session) {
      this.session = state.sessionId;
      this.sum = 0;
      this.count = 0;
    }
    this.runningSince = state.state === 'running' ? seq : undefined;
    const waiting = this.waiting;
    if (waiting !== undefined && this.runningSince !== undefined && waiting.seq > this.runningSince) {
      this.add(waiting.value, waiting.seq);
    }
  }

  /** Adds a reading; `value` undefined for an unavailable one. True when the average changed. */
  add(value: number | undefined, seq: number): boolean {
    if (seq <= this.lastSeq) return false;
    if (this.runningSince === undefined || seq <= this.runningSince) {
      this.waiting = { value, seq };
      return false;
    }
    this.waiting = undefined;
    this.lastSeq = seq;
    if (value === undefined) return false;
    this.sum += value;
    this.count += 1;
    return true;
  }

  get value(): number | undefined {
    return this.count === 0 ? undefined : this.sum / this.count;
  }
}
