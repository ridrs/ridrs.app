// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ActivityState,
  type HeartRateZones,
  type PowerZones,
  WORKOUT_INTENSITY,
  type WorkoutFinishedPayload,
  type WorkoutIntensityChangedPayload,
  type WorkoutStepChangedPayload,
  type WorkoutTarget,
} from '@ridrs/contracts';
import {
  defaultHeartRateZones,
  defaultPowerZones,
  type TimelineSegment,
  type TrainingZones,
  workoutTimeline,
} from '@ridrs/workout';

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

/**
 * A `#rrggbb` colour as the wide-gamut colour of the same coordinates in Display P3, at full
 * brightness: more vivid on a P3 or HDR screen (the Mac's), the nearest colour on an sRGB one.
 */
export function vivid(hex: string): string {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const brightest = Math.max(...channels, 1e-6);
  const [r, g, b] = channels.map((channel) => (channel / brightest).toFixed(3));
  return `color(display-p3 ${r} ${g} ${b})`;
}

/**
 * The lightness, in OKLCH, the lit scale keeps at least. The zone ramp starts with a deep blue
 * (`#0a3aff`, L 0.47) that all but vanishes on the navy glass (L 0.18): lit, every zone reads at
 * a glance, its hue unchanged.
 */
export const LIT_LIGHTNESS = 0.74;

/**
 * The lit colour of a zone: `vivid` at full brightness, lifted to `LIT_LIGHTNESS` where it is
 * darker, in CSS relative colour syntax, so the browser maps it to the screen's gamut.
 */
export function lit(hex: string): string {
  return `oklch(from ${vivid(hex)} max(l, ${LIT_LIGHTNESS}) c h)`;
}

/** The lightness of the part of the scale not lit yet: one for every zone, the hue tells them apart. */
export const TRACK_LIGHTNESS = 0.5;

/**
 * A `#rrggbb` colour as the track of the scale not lit yet: every zone at the same lightness, its
 * chroma reduced, solid. Dimming towards the dial instead left the first zones almost invisible
 * and the yellow ones brighter than the rest.
 */
export function dimmed(hex: string): string {
  return `oklch(from ${hex} ${TRACK_LIGHTNESS} calc(c * 0.6) h)`;
}

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
 * The heart rate gauge: from a round number below the first bound to the maximum heart rate
 * rounded up to the next 10 bpm, else to a round number above the last bound; coloured by the heart
 * rate zones (bpm; Friel's of the LTHR by default). A scale that ends at the maximum heart rate
 * starts low enough for its end to be a major, labelled tick.
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
  const low = Math.floor((first * 0.75) / 10) * 10;
  const end = maxHeartRate === undefined ? undefined : Math.ceil(maxHeartRate / 10) * 10;
  if (end !== undefined && end > low) {
    const major = niceStep(end - low);
    const min = Math.max(0, end - Math.ceil((end - low) / major) * major);
    return { min, max: end, major, minor: minorOf(major), bands: bandsOf(used, identity, min, end) };
  }
  const min = low;
  const reach = top + 10;
  const major = niceStep(reach - min);
  const max = min + Math.ceil((reach - min) / major) * major;
  return { min, max, major, minor: minorOf(major), bands: bandsOf(used, identity, min, max) };
}

/**
 * Cadence bands, upper bounds in rpm: the profile has no cadence zones, so the gauge shows fixed
 * bands around the usual 80 to 100 rpm of riding on a trainer.
 */
export const CADENCE_ZONES: TrainingZones = [{ upTo: 60 }, { upTo: 75 }, { upTo: 90 }, { upTo: 105 }, {}];

/**
 * Cadence is no intensity: the effort ramp would paint the sweet spot red. Its bands say how well
 * the rider spins instead: coasting slate, grinding amber, the sweet spot green, spinning out amber
 * again (`--ridrs-warn`, `--ridrs-ok` of the Kinetic look).
 */
export const CADENCE_COLOURS = ['#7c8ba1', '#ffb62e', '#a3e635', '#3ddc84', '#ffb62e'] as const;

export function cadenceScale(): Scale {
  const bands = bandsOf(CADENCE_ZONES, (rpm) => rpm, 0, 150).map((band) => ({
    ...band,
    colour: CADENCE_COLOURS[band.zone - 1] ?? CADENCE_COLOURS[0],
  }));
  return { min: 0, max: 150, major: 30, minor: 10, bands };
}

/** The band a value lies in, by the exact bounds (inclusive, as `zoneOf`); none on a neutral scale. */
export function bandAt(scale: Scale, value: number): Band | undefined {
  return scale.bands.find((band) => band.limit === undefined || value <= band.limit) ?? scale.bands.at(-1);
}

/** How far, as a share of the scale, a value must pass a zone's bound before the zone changes. */
export const ZONE_HYSTERESIS = 0.01;

/**
 * The band to show for `value`, given the band shown so far: it changes only once the value is
 * clearly in another zone, so a power that wavers around a bound does not flicker the scale
 * between two colours with every reading.
 */
export function bandNear(scale: Scale, value: number, shown: number | undefined): Band | undefined {
  const exact = bandAt(scale, value);
  const previous = scale.bands.find((band) => band.zone === shown);
  if (!exact || !previous || exact.zone === previous.zone) {
    return exact;
  }
  const margin = (scale.max - scale.min) * ZONE_HYSTERESIS;
  const below = scale.bands.find((band) => band.zone === previous.zone - 1);
  const lower = below?.limit ?? Number.NEGATIVE_INFINITY;
  const upper = previous.limit ?? Number.POSITIVE_INFINITY;
  return value > lower - margin && value <= upper + margin ? previous : exact;
}

/** The gauge's sweep: 250°, open at the bottom, clockwise from the lower left. */
export const START_ANGLE = 145;
export const SWEEP = 250;

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

/** Seconds as `1:02:03`, or `4:05` below an hour. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(Math.floor(seconds), 0);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * Whether the HDR canvas shows the dial (ADR 0099): only where there is one, and not while a
 * screenshot is taken, since the native snapshot fills a see-through WebGPU canvas with black
 * (ADR 0102). Otherwise the SVG shows itself.
 */
export function drawsOnHdrCanvas(hasHdrLayer: boolean, capturing: boolean): boolean {
  return hasHdrLayer && !capturing;
}

/** A workout target on a gauge's scale, in the gauge's unit (`low === high` for an exact value). */
export interface GaugeTarget {
  readonly low: number;
  readonly high: number;
}

/** The span of the spotlight and outer arc drawn on the scale, and the centre the triangle marks. */
export interface TargetWindow {
  readonly low: number;
  readonly high: number;
  readonly center: number;
}

/**
 * The least share of the scale a workout target's spotlight and outer arc span (±6 % around its
 * centre: 30° of the 250° sweep), so an exact target or a narrow range still frames its pointer.
 */
export const MIN_TARGET_SPAN = 0.12;

/**
 * The visual window `[low, high]` and `center` of `target` on `scale`, held within the scale with
 * at least `MIN_TARGET_SPAN` of the scale around `center`.
 */
export function targetWindow(scale: Scale, target: GaugeTarget): TargetWindow {
  const span = scale.max - scale.min;
  const minHalf = (span * MIN_TARGET_SPAN) / 2;
  const center = Math.min(scale.max, Math.max(scale.min, (target.low + target.high) / 2));
  const half = Math.max((target.high - target.low) / 2, minHalf);
  const low = Math.max(scale.min, Math.min(center - half, scale.max - minHalf));
  const high = Math.min(scale.max, Math.max(center + half, scale.min + minHalf));
  return { low, high, center };
}

/** Where a steady or ramped target stands at `share` (0 to 1) of its step. */
function rangeAt(target: WorkoutTarget, share: number): GaugeTarget {
  if (!target.end) {
    return { low: target.start.low, high: target.start.high };
  }
  const clamped = Math.min(1, Math.max(0, share));
  const at = (from: number, to: number) => from + (to - from) * clamped;
  return { low: at(target.start.low, target.end.low), high: at(target.start.high, target.end.high) };
}

/**
 * The power target (in watts, scaled by `intensityPercent`) and cadence target (in rpm) of
 * `segment` at `elapsedMs` into the step.
 */
export function stepTargets(
  segment: Pick<TimelineSegment, 'effort' | 'duration' | 'durationSeconds'> | undefined,
  ftp: number | undefined,
  intensityPercent = 100,
  elapsedMs = 0,
): { readonly power: GaugeTarget | undefined; readonly cadence: GaugeTarget | undefined } {
  if (!segment) {
    return { power: undefined, cadence: undefined };
  }
  const { effort, duration, durationSeconds } = segment;
  const share =
    duration.kind === 'time' && durationSeconds > 0
      ? Math.min(1, Math.max(0, elapsedMs / (durationSeconds * 1000)))
      : 0;
  let power: GaugeTarget | undefined;
  if (effort.kind === 'target') {
    const { primary } = effort;
    if (primary.unit === 'watts') {
      const raw = rangeAt(primary, share);
      const factor = intensityPercent / 100;
      power = { low: raw.low * factor, high: raw.high * factor };
    } else if (primary.unit === 'percent-ftp' && ftp !== undefined) {
      const raw = rangeAt(primary, share);
      const factor = (ftp * intensityPercent) / 10000;
      power = { low: raw.low * factor, high: raw.high * factor };
    }
  }
  const targets =
    effort.kind === 'max-effort'
      ? []
      : effort.kind === 'target'
        ? [effort.primary, ...(effort.secondary ?? [])]
        : (effort.secondary ?? []);
  const rpm = targets.find((item) => item.unit === 'rpm');
  const cadence = rpm ? rangeAt(rpm, share) : undefined;
  return { power, cadence };
}

/** How long, in ms, the target indicator takes to glide from one workout step's target to the next. */
export const TARGET_TRANSITION_MS = 400;

/**
 * Glides a gauge's target from `from` (the previous step's target) to `to` (the current step's
 * target) over `TARGET_TRANSITION_MS` with a cubic ease-out, so a step change moves smoothly
 * along the scale instead of jumping. Without a previous target, `to` shows at once.
 */
export function interpolateTarget(
  from: GaugeTarget | undefined,
  to: GaugeTarget | undefined,
  elapsedStepMs: number,
): GaugeTarget | undefined {
  if (!to) {
    return undefined;
  }
  if (!from || elapsedStepMs >= TARGET_TRANSITION_MS) {
    return to;
  }
  if (elapsedStepMs <= 0) {
    return from;
  }
  const progress = elapsedStepMs / TARGET_TRANSITION_MS;
  const ease = 1 - (1 - progress) ** 3;
  return {
    low: from.low + (to.low - from.low) * ease,
    high: from.high + (to.high - from.high) * ease,
  };
}

interface ActiveStep {
  readonly index: number;
  readonly startedAt: number;
  readonly fromPower: GaugeTarget | undefined;
  readonly fromCadence: GaugeTarget | undefined;
}

function segmentHasRamp(segment: TimelineSegment): boolean {
  if (segment.effort.kind === 'max-effort') return false;
  const targets =
    segment.effort.kind === 'target'
      ? [segment.effort.primary, ...(segment.effort.secondary ?? [])]
      : (segment.effort.secondary ?? []);
  return targets.some((item) => item.end !== undefined);
}

function sameTarget(a: GaugeTarget | undefined, b: GaugeTarget | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return Math.round(a.low) === Math.round(b.low) && Math.round(a.high) === Math.round(b.high);
}

export interface ActiveWorkoutStepInfo {
  readonly index: number;
  readonly elapsedSeconds: number;
  readonly durationSeconds: number | undefined;
  readonly progress: number;
  readonly running: boolean;
}

/**
 * Follows the ride's active workout and its steps, returning the power and cadence targets to draw
 * on the gauges at `now`, the active step's timing and progress, and whether a step transition or
 * ramp is still moving.
 */
export class WorkoutTargetTracker {
  private sessionId: string | undefined;
  private startedAt = 0;
  private workoutKey: string | undefined;
  private segments: readonly TimelineSegment[] = [];
  private step: ActiveStep | undefined;
  private pausedAt: number | undefined;
  private pausedMs = 0;
  private finishedAt: number | undefined;
  private intensity: { readonly at: number; readonly percent: number } | undefined;
  private ftp: number | undefined;

  setFtp(ftp: number | undefined): void {
    this.ftp = ftp;
  }

  activity(state: ActivityState): void {
    if (state.state === 'idle' || state.state === 'finished') {
      this.sessionId = undefined;
      this.workoutKey = undefined;
      this.segments = [];
      this.step = undefined;
      this.pausedAt = undefined;
      this.pausedMs = 0;
      this.finishedAt = undefined;
      return;
    }
    const nextKey = state.workout?.workout ? JSON.stringify(state.workout.workout) : undefined;
    if (state.sessionId !== this.sessionId) {
      this.sessionId = state.sessionId;
      this.startedAt = state.startedAt;
      this.workoutKey = nextKey;
      this.segments = state.workout?.workout ? workoutTimeline(state.workout.workout).segments : [];
      this.step = undefined;
      this.pausedAt = undefined;
      this.pausedMs = 0;
      this.finishedAt = undefined;
      this.intensity = undefined;
    } else if (nextKey !== this.workoutKey) {
      this.workoutKey = nextKey;
      this.segments = state.workout?.workout ? workoutTimeline(state.workout.workout).segments : [];
      this.step = undefined;
      this.pausedMs = 0;
      this.finishedAt = undefined;
      this.intensity = undefined;
    }
    if (state.state === 'paused') {
      this.pausedAt ??= state.pausedAt;
    } else if (this.pausedAt !== undefined && state.resumedAt !== undefined) {
      this.pausedMs += Math.max(0, state.resumedAt - this.pausedAt);
      this.pausedAt = undefined;
    }
  }

  stepChanged(payload: WorkoutStepChangedPayload): void {
    const previous = this.at(payload.startedAt);
    this.step = {
      index: payload.index,
      startedAt: payload.startedAt,
      fromPower: previous.power,
      fromCadence: previous.cadence,
    };
    this.pausedMs = 0;
  }

  finished(payload: WorkoutFinishedPayload): void {
    this.finishedAt = payload.at;
  }

  intensityChanged(payload: WorkoutIntensityChangedPayload, timestamp: number): void {
    this.intensity = { at: timestamp, percent: payload.percent };
  }

  at(
    now: number,
    ftp = this.ftp,
  ): {
    readonly power: GaugeTarget | undefined;
    readonly cadence: GaugeTarget | undefined;
    readonly animating: boolean;
  } {
    this.ftp = ftp;
    if (
      !this.sessionId ||
      this.segments.length === 0 ||
      !this.step ||
      this.step.startedAt < this.startedAt ||
      (this.finishedAt !== undefined &&
        this.finishedAt >= this.startedAt &&
        this.finishedAt >= this.step.startedAt)
    ) {
      return { power: undefined, cadence: undefined, animating: false };
    }
    const segment = this.segments[this.step.index];
    if (!segment) {
      return { power: undefined, cadence: undefined, animating: false };
    }
    const clock = this.pausedAt ?? now;
    const elapsedMs = Math.max(0, clock - this.step.startedAt - this.pausedMs);
    const percent =
      this.intensity && this.intensity.at >= this.startedAt
        ? this.intensity.percent
        : WORKOUT_INTENSITY.default;
    const raw = stepTargets(segment, ftp, percent, elapsedMs);
    const power = interpolateTarget(this.step.fromPower, raw.power, elapsedMs);
    const cadence = interpolateTarget(this.step.fromCadence, raw.cadence, elapsedMs);
    const powerMoving =
      elapsedMs < TARGET_TRANSITION_MS &&
      this.step.fromPower !== undefined &&
      raw.power !== undefined &&
      !sameTarget(this.step.fromPower, raw.power);
    const cadenceMoving =
      elapsedMs < TARGET_TRANSITION_MS &&
      this.step.fromCadence !== undefined &&
      raw.cadence !== undefined &&
      !sameTarget(this.step.fromCadence, raw.cadence);
    const rampMoving =
      this.pausedAt === undefined &&
      segmentHasRamp(segment) &&
      segment.duration.kind === 'time' &&
      elapsedMs < segment.durationSeconds * 1000;
    return { power, cadence, animating: powerMoving || cadenceMoving || rampMoving };
  }

  /** Timing and progress of the active workout step at `now`; none when no workout step runs. */
  stepAt(now: number): ActiveWorkoutStepInfo | undefined {
    if (
      !this.sessionId ||
      this.segments.length === 0 ||
      !this.step ||
      this.step.startedAt < this.startedAt ||
      (this.finishedAt !== undefined &&
        this.finishedAt >= this.startedAt &&
        this.finishedAt >= this.step.startedAt)
    ) {
      return undefined;
    }
    const segment = this.segments[this.step.index];
    if (!segment) {
      return undefined;
    }
    const clock = this.pausedAt ?? now;
    const elapsedMs = Math.max(0, clock - this.step.startedAt - this.pausedMs);
    const durationSeconds = segment.duration.kind === 'time' ? segment.durationSeconds : undefined;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const progress =
      durationSeconds !== undefined && durationSeconds > 0
        ? Math.min(Math.max(elapsedMs / (durationSeconds * 1000), 0), 1)
        : 0;
    return {
      index: this.step.index,
      elapsedSeconds,
      durationSeconds,
      progress,
      running: this.pausedAt === undefined,
    };
  }
}
