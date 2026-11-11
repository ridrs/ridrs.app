// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import type {
  Workout,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutRange,
  WorkoutRepeat,
  WorkoutRepeatUntil,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import {
  defaultHeartRateZones,
  defaultPowerZones,
  layoutWorkout,
  resolveTarget,
  resolveWorkout,
  segmentAt,
  validateWorkout,
  type WorkoutAthlete,
  type WorkoutLayout,
  type WorkoutMetrics,
  type WorkoutResolution,
  type WorkoutTimeline,
  workoutMetrics,
  workoutTimeline,
  zoneOf,
} from '@ridrs/workout';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The core of @ridrs/workout, headless: workouts written as a table of steps in the words of the
 * plan ("10 min", "ramp 50→75 %", "3×"), checked, unrolled, resolved, measured and laid out.
 */

interface Scenario {
  workout?: Workout;
  athlete?: WorkoutAthlete;
  diagnostics?: ReturnType<typeof validateWorkout>;
  timeline?: WorkoutTimeline;
  resolution?: WorkoutResolution;
  metrics?: WorkoutMetrics;
  layout?: WorkoutLayout;
  previousLayout?: WorkoutLayout;
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  const found = scenarios.get(world) ?? {};
  scenarios.set(world, found);
  return found;
}

const required = <T>(value: T | undefined, what: string): T => {
  assert.ok(value !== undefined, `Expected ${what}`);
  return value;
};

// --- Words of the plan → the model ---------------------------------------------------------

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const UNITS: Record<string, WorkoutTarget['unit']> = {
  '%': 'percent-ftp',
  W: 'watts',
  bpm: 'bpm',
  rpm: 'rpm',
  '% LTHR': 'percent-lthr',
  '% max HR': 'percent-max-hr',
};
const SYMBOLS: Partial<Record<WorkoutTarget['unit'], string>> = Object.fromEntries(
  Object.entries(UNITS).map(([symbol, unit]) => [unit, symbol]),
);

/** "90 %", "88–94 %", "ramp 50→75 %", "200–220 W", "Z2", "HR Z2", "95 % LTHR". */
function parseTarget(text: string): WorkoutTarget {
  const zone = /^(HR )?Z(\d+)$/.exec(text);
  if (zone) {
    const n = Number(zone[2]);
    return { unit: zone[1] ? 'hr-zone' : 'power-zone', start: { low: n, high: n } };
  }
  const ramp = new RegExp(`^ramp ${NUMBER}→${NUMBER} (.+)$`).exec(text);
  if (ramp) {
    const [from, to] = [Number(ramp[1]), Number(ramp[2])];
    return {
      unit: required(UNITS[ramp[3] ?? ''], `a unit in "${text}"`),
      start: { low: from, high: from },
      end: { low: to, high: to },
    };
  }
  const steady = new RegExp(`^${NUMBER}(?:–${NUMBER})? (.+)$`).exec(text);
  assert.ok(steady, `Cannot read the target "${text}"`);
  const low = Number(steady[1]);
  const high = steady[2] === undefined ? low : Number(steady[2]);
  return { unit: required(UNITS[steady[3] ?? ''], `a unit in "${text}"`), start: { low, high } };
}

function parseEffort(text: string): WorkoutEffort {
  if (text === 'free ride') return { kind: 'free' };
  if (text === 'max effort') return { kind: 'max-effort' };
  return { kind: 'target', primary: parseTarget(text) };
}

/** "10 min", "30 s", "1 h", "5 km", "90 kcal", "open", "until heart rate below 110 bpm". */
function parseDuration(text: string): WorkoutDuration {
  if (text === 'open') return { kind: 'open' };
  const until = new RegExp(`^until heart rate (above|below) ${NUMBER} bpm$`).exec(text);
  if (until) {
    return {
      kind: 'until',
      unit: 'bpm',
      comparison: until[1] as 'above' | 'below',
      value: Number(until[2]),
    };
  }
  const amount = new RegExp(`^${NUMBER} (h|min|s|km|kcal)$`).exec(text);
  assert.ok(amount, `Cannot read the duration "${text}"`);
  const value = Number(amount[1]);
  switch (amount[2]) {
    case 'h':
      return { kind: 'time', seconds: value * 3600 };
    case 'min':
      return { kind: 'time', seconds: value * 60 };
    case 'km':
      return { kind: 'distance', meters: value * 1000 };
    case 'kcal':
      return { kind: 'energy', kilocalories: value };
    default:
      return { kind: 'time', seconds: value };
  }
}

/** "3×" or "for 20 min"; undefined for an interval's duration. */
function parseRepeat(text: string): WorkoutRepeatUntil | undefined {
  const count = /^(\d+)×$/.exec(text);
  if (count) return { kind: 'count', reps: Number(count[1]) };
  const time = /^for (.+)$/.exec(text);
  if (time) {
    const duration = parseDuration(time[1] ?? '');
    assert.equal(duration.kind, 'time');
    return { kind: 'time', seconds: duration.kind === 'time' ? duration.seconds : 0 };
  }
  return undefined;
}

/** Builds steps from rows; "2.1" belongs to the repeat "2" above it. */
function buildSteps(rows: readonly Record<string, string>[]): WorkoutStep[] {
  type Draft = { step: WorkoutStep; children?: Draft[] };
  const top: Draft[] = [];
  const repeats = new Map<string, Draft>();
  for (const row of rows) {
    const id = required(row.id, 'an id');
    const durationText = row.duration ?? '';
    const until = parseRepeat(durationText);
    const draft: Draft = until
      ? { step: { kind: 'repeat', id, until, steps: [] }, children: [] }
      : {
          step: {
            kind: 'interval',
            id,
            duration: parseDuration(durationText),
            effort: parseEffort(row.target ?? ''),
          },
        };
    const parent = id.includes('.') ? repeats.get(id.slice(0, id.lastIndexOf('.'))) : undefined;
    (parent?.children ?? top).push(draft);
    if (until) repeats.set(id, draft);
  }
  const finish = (draft: Draft): WorkoutStep =>
    draft.step.kind === 'repeat'
      ? ({ ...draft.step, steps: (draft.children ?? []).map(finish) } satisfies WorkoutRepeat)
      : draft.step;
  return top.map(finish);
}

function workoutOf(name: string, steps: WorkoutStep[]): Workout {
  return {
    format: 'ridrs-workout',
    version: 1,
    id: 'test',
    name,
    sport: 'virtual-ride',
    source: { kind: 'user' },
    steps,
  };
}

const range = (value: WorkoutRange) =>
  value.low === value.high ? `${value.low}` : `${value.low}–${value.high}`;

/** The words of a target again: "225 W", "ramp 125→188 W", "Z7", "HR Z2". */
function describeTarget(target: WorkoutTarget): string {
  if (target.unit === 'power-zone') return `Z${range(target.start)}`;
  if (target.unit === 'hr-zone') return `HR Z${range(target.start)}`;
  const symbol = SYMBOLS[target.unit] ?? target.unit;
  return target.end
    ? `ramp ${range(target.start)}→${range(target.end)} ${symbol}`
    : `${range(target.start)} ${symbol}`;
}

/** "1:00:00", "10:00", "0:00" in s, and back. */
function parseClock(text: string): number {
  return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const list = (text: string) => text.split(/,\s*|\s+and\s+/).map((each) => each.trim());

// --- Givens ------------------------------------------------------------------------------------

Given(
  'a workout {string} built from these steps:',
  function (this: RidrsWorld, name: string, table: DataTable) {
    scenario(this).workout = workoutOf(name, buildSteps(table.hashes()));
  },
);

Given('a workout {string} without steps', function (this: RidrsWorld, name: string) {
  scenario(this).workout = workoutOf(name, []);
});

Given(
  'an athlete for workouts with an FTP of {int} W and the default power zones',
  function (this: RidrsWorld, ftp: number) {
    scenario(this).athlete = { ftp, powerZones: defaultPowerZones() };
  },
);

Given('an athlete for workouts with an FTP of {int} W', function (this: RidrsWorld, ftp: number) {
  scenario(this).athlete = { ftp };
});

Given('an athlete for workouts without an FTP', function (this: RidrsWorld) {
  scenario(this).athlete = {};
});

Given(
  'an athlete for workouts with an LTHR of {int} bpm, a maximum heart rate of {int} bpm and the default heart rate zones',
  function (this: RidrsWorld, lthr: number, maxHeartRate: number) {
    scenario(this).athlete = { lthr, maxHeartRate, heartRateZones: defaultHeartRateZones(lthr) };
  },
);

const workout = (world: RidrsWorld) => required(scenario(world).workout, 'a workout');
const athlete = (world: RidrsWorld) => scenario(world).athlete ?? {};

// --- Validation -------------------------------------------------------------------------------

When('the workout is checked', function (this: RidrsWorld) {
  scenario(this).diagnostics = validateWorkout(workout(this));
});

Then('the check finds no problems', function (this: RidrsWorld) {
  assert.deepEqual(required(scenario(this).diagnostics, 'a check'), []);
});

Then('the check finds these problems:', function (this: RidrsWorld, table: DataTable) {
  const found = required(scenario(this).diagnostics, 'a check');
  assert.deepEqual(
    found.map((each) => ({ code: each.code, step: each.at ?? '' })),
    table.hashes().map((row) => ({ code: row.code, step: row.step ?? '' })),
  );
  assert.ok(found.every((each) => each.severity === 'error'));
});

// --- Timeline ---------------------------------------------------------------------------------

When("the workout's timeline is made", function (this: RidrsWorld) {
  scenario(this).timeline = workoutTimeline(workout(this));
});

const timeline = (world: RidrsWorld) => required(scenario(world).timeline, 'a timeline');

Then(
  /^the timeline lasts ([\d:]+), (not estimated|estimated)$/,
  function (this: RidrsWorld, length: string, estimated: string) {
    const made = timeline(this);
    assert.equal(clock(made.durationSeconds), length);
    assert.equal(made.estimated, estimated === 'estimated');
  },
);

const round = (segment: WorkoutTimeline['segments'][number]) =>
  segment.repeats.map((each) => `${each.iteration}/${each.count ?? '?'}`).join(' ');

Then('the timeline has these segments:', function (this: RidrsWorld, table: DataTable) {
  assert.deepEqual(
    timeline(this).segments.map((segment) => ({
      step: segment.stepId,
      round: round(segment),
      starts: clock(segment.startSeconds),
      lasts: clock(segment.durationSeconds),
      estimated: segment.estimated ? 'yes' : 'no',
    })),
    table.hashes(),
  );
});

Then(
  /^at ([\d:]+) the timeline is in step "([^"]+)"(?:, round "([^"]+)",)? with ([\d:]+) left$/,
  function (this: RidrsWorld, at: string, step: string, inRound: string | null, left: string) {
    const found = required(segmentAt(timeline(this), parseClock(at)), `a segment at ${at}`);
    assert.equal(found.segment.stepId, step);
    if (inRound) assert.equal(round(found.segment), inRound);
    assert.equal(clock(found.remainingSeconds), left);
  },
);

Then('at {word} the timeline has ended', function (this: RidrsWorld, at: string) {
  assert.equal(segmentAt(timeline(this), parseClock(at)), undefined);
});

// --- Zones and targets ------------------------------------------------------------------------

Then(/^the default power zones end at (.+) % FTP, the last one open$/, (bounds: string) => {
  const zones = defaultPowerZones();
  assert.deepEqual(
    zones.map((zone) => zone.upTo),
    [...list(bounds).map(Number), undefined],
  );
});

Then('the default power zones are named {string}', (names: string) => {
  assert.deepEqual(
    defaultPowerZones().map((zone) => zone.name),
    names.split(', '),
  );
});

Then(
  /^the default heart rate zones for an LTHR of (\d+) bpm end at (.+) bpm, the last one open$/,
  (lthr: string, bounds: string) => {
    assert.deepEqual(
      defaultHeartRateZones(Number(lthr)).map((zone) => zone.upTo),
      [...list(bounds).map(Number), undefined],
    );
  },
);

Then('{float} % FTP lies in default power zone {int}', (value: number, zone: number) => {
  assert.equal(zoneOf(value, defaultPowerZones()), zone);
});

Then(
  'the target {string} resolves to {string}',
  function (this: RidrsWorld, target: string, expected: string) {
    const resolved = resolveTarget(parseTarget(target), athlete(this));
    assert.ok(resolved.ok, JSON.stringify(resolved));
    const words = describeTarget(resolved.target);
    assert.equal(resolved.openAbove ? `${words} and above` : words, expected);
  },
);

Then(
  'the target {string} cannot be resolved: {string}',
  function (this: RidrsWorld, target: string, reason: string) {
    assert.deepEqual(resolveTarget(parseTarget(target), athlete(this)), { ok: false, reason });
  },
);

When('the workout is resolved for the ride', function (this: RidrsWorld) {
  scenario(this).resolution = resolveWorkout(workout(this), athlete(this));
});

function targetsByStep(steps: readonly WorkoutStep[]): Map<string, WorkoutTarget> {
  const found = new Map<string, WorkoutTarget>();
  for (const step of steps) {
    if (step.kind === 'repeat') {
      for (const [id, target] of targetsByStep(step.steps)) found.set(id, target);
    } else if (step.effort.kind === 'target') {
      found.set(step.id, step.effort.primary);
    }
  }
  return found;
}

const resolution = (world: RidrsWorld) => required(scenario(world).resolution, 'a resolution');

Then('the resolved workout targets:', function (this: RidrsWorld, table: DataTable) {
  const targets = targetsByStep(resolution(this).workout.steps);
  for (const row of table.hashes()) {
    const step = row.step ?? '';
    assert.equal(describeTarget(required(targets.get(step), `step ${step}`)), row.target, step);
  }
});

Then('nothing in the resolved workout is left unresolved', function (this: RidrsWorld) {
  assert.deepEqual(resolution(this).issues, []);
});

Then(
  'the resolved workout leaves these unresolved:',
  function (this: RidrsWorld, table: DataTable) {
    assert.deepEqual(
      resolution(this).issues.map((issue) => ({ step: issue.stepId, problem: issue.code })),
      table.hashes(),
    );
  },
);

Then(
  'the workout itself still targets {string} in step {string}',
  function (this: RidrsWorld, target: string, step: string) {
    const original = required(targetsByStep(workout(this).steps).get(step), `step ${step}`);
    assert.equal(describeTarget(original), target);
  },
);

// --- Metrics ----------------------------------------------------------------------------------

When("the workout's numbers are derived", function (this: RidrsWorld) {
  scenario(this).metrics = workoutMetrics(workout(this), athlete(this));
});

const metrics = (world: RidrsWorld) => required(scenario(world).metrics, 'derived numbers');

/** Each number as the scenarios write it, rounded as a rider reads it. */
const NUMBERS: Record<string, (found: WorkoutMetrics) => string | undefined> = {
  duration: (found) => clock(found.durationSeconds),
  estimated: (found) => (found.durationEstimated || found.intensityEstimated ? 'yes' : 'no'),
  'normalised power': (found) =>
    found.normalizedPowerWatts === undefined
      ? undefined
      : `${Math.round(found.normalizedPowerWatts)} W`,
  'intensity factor': (found) => found.intensityFactor?.toFixed(2),
  'training load': (found) =>
    found.trainingLoad === undefined ? undefined : `${Math.round(found.trainingLoad)}`,
  work: (found) =>
    found.kilojoules === undefined ? undefined : `${Math.round(found.kilojoules)} kJ`,
};

Then("the workout's numbers are:", function (this: RidrsWorld, table: DataTable) {
  const found = metrics(this);
  for (const [name = '', expected] of table.raw()) {
    const read = required(NUMBERS[name], `a number called "${name}"`);
    assert.equal(read(found), expected, `${name}: ${JSON.stringify(found)}`);
  }
});

Then(
  "the workout's numbers have no normalised power in watts, no work and no time per zone",
  function (this: RidrsWorld) {
    const found = metrics(this);
    assert.equal(found.normalizedPowerWatts, undefined);
    assert.equal(found.kilojoules, undefined);
    assert.equal(found.timeInZones, undefined);
  },
);

Then("the workout's numbers have no intensity factor and no load", function (this: RidrsWorld) {
  const found = metrics(this);
  assert.equal(found.intensityFactor, undefined);
  assert.equal(found.trainingLoad, undefined);
});

Then('the workout spends this time per zone:', function (this: RidrsWorld, table: DataTable) {
  const zones = required(metrics(this).timeInZones, 'time per zone');
  assert.deepEqual(
    zones.map((seconds, index) => ({ zone: `${index + 1}`, time: clock(seconds) })),
    table.hashes(),
  );
});

Then('the workout spends {word} without a power target', function (this: RidrsWorld, time: string) {
  assert.equal(clock(metrics(this).secondsWithoutPowerTarget), time);
});

Then('ERG can ride the steps {string}', function (this: RidrsWorld, steps: string) {
  assert.deepEqual(metrics(this).ergStepIds, list(steps));
});

// --- Chart geometry ---------------------------------------------------------------------------

function layOut(world: RidrsWorld, width: number, height: number, variant?: string) {
  const current = scenario(world);
  current.previousLayout = current.layout;
  current.layout = layoutWorkout(workout(world), {
    width,
    height,
    athlete: athlete(world),
    ...(variant ? { variant: variant as 'micro' } : {}),
  });
}

When(
  /^the workout is laid out(?: again)? at (\d+) × (\d+)(?: as "(\w+)")?$/,
  function (this: RidrsWorld, width: string, height: string, variant: string | null) {
    layOut(this, Number(width), Number(height), variant ?? undefined);
  },
);

const layout = (world: RidrsWorld) => required(scenario(world).layout, 'a layout');
const shape = (world: RidrsWorld, n: number) =>
  required(layout(world).shapes[n - 1], `segment ${n} in the chart`);

/** "(0,150) (0,100)" with coordinates rounded to two decimals. */
const points = (list: readonly (readonly [number, number])[]) =>
  list.map(([x, y]) => `(${+x.toFixed(2)},${+y.toFixed(2)})`).join(' ');

Then(
  /^the chart draws segment (\d+) as the polygon "([^"]+)" in (?:zone (\d+)|no zone)$/,
  function (this: RidrsWorld, n: string, polygon: string, zone: string | null) {
    const drawn = shape(this, Number(n));
    assert.equal(points(drawn.polygon), polygon);
    assert.equal(drawn.zone, zone === null ? undefined : Number(zone));
  },
);

Then(
  'the chart draws segment {int} with the band {string}',
  function (this: RidrsWorld, n: number, band: string) {
    assert.equal(points(required(shape(this, n).band, 'a band')), band);
  },
);

Then('the chart clips segment {int}', function (this: RidrsWorld, n: number) {
  assert.equal(shape(this, n).clipped, true);
});

Then('the chart does not clip segment {int}', function (this: RidrsWorld, n: number) {
  assert.equal(shape(this, n).clipped, false);
});

Then(
  /^the chart's axis is in "([\w-]+)" up to (\d+) with ticks "([^"]+)"(?: and no watts| and watts "([^"]+)")?$/,
  function (this: RidrsWorld, unit: string, max: string, ticks: string, watts: string | null) {
    const { axis } = layout(this);
    assert.equal(axis.unit, unit);
    assert.equal(axis.max, Number(max));
    assert.deepEqual(
      axis.ticks.map((tick) => tick.value),
      list(ticks).map(Number),
    );
    assert.deepEqual(
      axis.ticks.map((tick) => tick.watts),
      watts ? list(watts).map(Number) : axis.ticks.map(() => undefined),
    );
  },
);

Then('the chart has no FTP line', function (this: RidrsWorld) {
  assert.equal(layout(this).ftpLine, undefined);
});

Then("the chart's FTP line lies at y {float}", function (this: RidrsWorld, y: number) {
  assert.equal(required(layout(this).ftpLine, 'an FTP line').y, y);
});

Then(
  'the chart draws segment {int} at a height of y {float}',
  function (this: RidrsWorld, n: number, y: number) {
    assert.equal(+(shape(this, n).polygon[1]?.[1] ?? Number.NaN).toFixed(2), y);
  },
);

Then('the chart hatches these segments:', function (this: RidrsWorld, table: DataTable) {
  const { axis } = layout(this);
  for (const row of table.hashes()) {
    const n = Number(row.segment);
    const drawn = shape(this, n);
    const y = drawn.polygon[1]?.[1] ?? Number.NaN;
    const height = ((layout(this).height - y) / layout(this).height) * axis.max;
    assert.deepEqual(
      {
        marker: drawn.marker,
        height: `${+height.toFixed(2)} %`,
        'height estimated': drawn.heightEstimated ? 'yes' : 'no',
        'width estimated': drawn.widthEstimated ? 'yes' : 'no',
      },
      {
        marker: row.marker,
        height: row.height,
        'height estimated': row['height estimated'],
        'width estimated': row['width estimated'],
      },
      `segment ${n}`,
    );
  }
});

Then("the chart's time axis is ticked at {string}", function (this: RidrsWorld, ticks: string) {
  const { timeTicks, width, durationSeconds } = layout(this);
  assert.deepEqual(
    timeTicks.map((tick) => clock(tick.value)),
    list(ticks),
  );
  for (const tick of timeTicks) assert.equal(tick.at, (tick.value / durationSeconds) * width);
});

Then(
  /^the chart brackets "(\d+)×" from x (\d+) to x (\d+)$/,
  function (this: RidrsWorld, count: string, x0: string, x1: string) {
    assert.deepEqual(
      layout(this).brackets.map((bracket) => ({
        count: bracket.count,
        x0: bracket.x0,
        x1: bracket.x1,
      })),
      [{ count: Number(count), x0: Number(x0), x1: Number(x1) }],
    );
  },
);

Then('the chart has no FTP line, no axes and no brackets', function (this: RidrsWorld) {
  const found = layout(this);
  assert.equal(found.ftpLine, undefined);
  assert.deepEqual(found.axis.ticks, []);
  assert.deepEqual(found.timeTicks, []);
  assert.deepEqual(found.brackets, []);
});

Then(
  /^the chart's summary is a ([\d:]+) workout, (not estimated|estimated), with (\d+) intervals? of ([\d:]+) at (\d+) %$/,
  function (
    this: RidrsWorld,
    length: string,
    estimated: string,
    count: string,
    each: string,
    value: string,
  ) {
    const { summary } = layout(this);
    assert.equal(clock(summary.durationSeconds), length);
    assert.equal(summary.durationEstimated, estimated === 'estimated');
    const main = required(summary.mainIntervals, 'main intervals');
    assert.deepEqual(
      { count: main.count, each: clock(main.durationSeconds), value: main.value },
      { count: Number(count), each, value: Number(value) },
    );
  },
);

Then('the chart layout is the very same as before', function (this: RidrsWorld) {
  assert.equal(layout(this), scenario(this).previousLayout);
});

Then('the chart layout is a new one', function (this: RidrsWorld) {
  assert.notEqual(layout(this), scenario(this).previousLayout);
});
