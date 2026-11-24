// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  planRefinement,
  REFINEMENT_RIDER,
  type RefinedStretch,
  type RefinementPlan,
  type RefinementSample,
  steadySpeed,
  TIME_STEP,
} from '@ridrs/ride';
import type { TrackPoint } from '../../plugins/ui-world-video/client/library.ts';
import { buildTrack, type Track } from '../../plugins/ui-world-video/client/track.ts';
import type { RidrsWorld } from '../support/world.ts';
import { kmh } from './video-time.steps.ts';

/*
 * Where a route's video needs in-between frames, headless: synthetic tracks due north with a
 * point every second, their elevation from a road profile.
 */

interface Scenario {
  frameRate?: number;
  track?: Track;
  /** m along the route where the climb of a one-climb profile starts and ends. */
  climb?: { from: number; to: number };
  cuts?: number[];
  plan?: RefinementPlan;
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

/** m along the meridian per degree of latitude, as the haversine distance has it near 45° N. */
const METRES_PER_DEGREE = 111_195;

/** `2 km`, `0.5 km`, `8 m`, `-30 m` in m. */
const metres = (cell: string | undefined) => {
  const value = Number.parseFloat(cell ?? '');
  return /km/.test(cell ?? '') ? value * 1000 : value;
};

/** The elevation (m) at `distance` of a profile given as sections of `length` m rising `rise` m. */
function profile(
  sections: readonly { length: number; rise: number }[],
): (distance: number) => number {
  return (distance) => {
    let at = 0;
    let elevation = 500;
    for (const { length, rise } of sections) {
      if (distance <= at + length) return elevation + (rise * (distance - at)) / length;
      at += length;
      elevation += rise;
    }
    return elevation;
  };
}

/** Points every second due north at `speed` m/s along `length` m, standing still where `stops` say. */
function filmedPoints(
  length: number,
  speed: number,
  elevationAt: (distance: number) => number,
  stops: readonly { at: number; seconds: number }[] = [],
): TrackPoint[] {
  const points: TrackPoint[] = [];
  let time = 0;
  let distance = 0;
  const push = () =>
    points.push({
      latitude: 45 + distance / METRES_PER_DEGREE,
      longitude: 5,
      elevation: elevationAt(distance),
      time,
    });
  push();
  const ahead = [...stops];
  while (distance < length - 1e-6) {
    const stop = ahead.find((s) => s.at > distance && s.at <= distance + speed);
    if (stop) ahead.splice(ahead.indexOf(stop), 1);
    time += 1;
    distance = Math.min(length, stop ? stop.at : distance + speed);
    push();
    if (stop) {
      for (let s = 0; s < stop.seconds; s += 1) {
        time += 1;
        push();
      }
    }
  }
  return points;
}

Given(
  'a video at {int} fps filmed at {int} km\\/h along a road that runs',
  function (this: RidrsWorld, frameRate: number, speed: number, table: DataTable) {
    const sections = table
      .hashes()
      .map((row) => ({ length: metres(row.for), rise: metres(row.rising) }));
    const current = scenario(this);
    current.frameRate = frameRate;
    const starts = sections.map((_, i) =>
      sections.slice(0, i).reduce((sum, s) => sum + s.length, 0),
    );
    const length = sections.reduce((sum, s) => sum + s.length, 0);
    if (sections.length >= 3) {
      current.climb = { from: starts[1] ?? 0, to: (starts[1] ?? 0) + (sections[1]?.length ?? 0) };
    }
    current.track = buildTrack(filmedPoints(length, kmh(speed), profile(sections)));
  },
);

Given(
  'a video at {int} fps filmed at {int} km\\/h along a road rising {int} % for {int} s, slowing to {int} km\\/h for {int} s after {int} s',
  function (
    this: RidrsWorld,
    frameRate: number,
    speed: number,
    rising: number,
    duration: number,
    slow: number,
    slowFor: number,
    after: number,
  ) {
    const current = scenario(this);
    current.frameRate = frameRate;
    const points: TrackPoint[] = [];
    let distance = 0;
    for (let time = 0; time <= duration; time += 1) {
      points.push({
        latitude: 45 + distance / METRES_PER_DEGREE,
        longitude: 5,
        elevation: 500 + (rising / 100) * distance,
        time,
      });
      distance += kmh(time >= after && time < after + slowFor ? slow : speed);
    }
    current.track = buildTrack(points);
  },
);

Given(
  'a video at {int} fps filmed from a car that drives {int} m at {int} km\\/h, stands still for {int} s and drives {int} m again on the flat',
  function (
    this: RidrsWorld,
    frameRate: number,
    before: number,
    speed: number,
    still: number,
    after: number,
  ) {
    const current = scenario(this);
    current.frameRate = frameRate;
    current.track = buildTrack(
      filmedPoints(before + after, kmh(speed), () => 500, [{ at: before, seconds: still }]),
    );
  },
);

Given(
  'the track jumps {int} m up across its point at {int} s, a cut of the video',
  function (this: RidrsWorld, metres: number, time: number) {
    const current = scenario(this);
    const track = required(current.track, 'a track');
    const at = track.points.findIndex((point) => point.time === time);
    assert.ok(at > 0, `Expected a point at ${time} s`);
    // From the point on, the road lies `metres` higher; the plausible track names it a step (ADR 0063).
    const points = track.points.map((point, i) =>
      i >= at ? { ...point, elevation: point.elevation + metres } : point,
    );
    const steps = points.slice(1).map((_, i) => (i === at - 1 ? metres : 0));
    current.track = { ...buildTrack(points), steps };
  },
);

Given('the video is cut at {int} s', function (this: RidrsWorld, time: number) {
  const current = scenario(this);
  current.cuts = [...(current.cuts ?? []), time];
});

When('its refinement is planned for {int} W', function (this: RidrsWorld, power: number) {
  const current = scenario(this);
  current.plan = planRefinement({
    track: required(current.track, 'a track'),
    frameRate: required(current.frameRate, 'a frame rate'),
    cuts: current.cuts,
    power,
  });
});

const speedResult = new WeakMap<RidrsWorld, number>();

When(
  'a rider of {int} kg rides at {int} W on a gradient of {int} %',
  function (this: RidrsWorld, mass: number, power: number, gradient: number) {
    speedResult.set(this, steadySpeed(power, gradient / 100, { ...REFINEMENT_RIDER, mass }));
  },
);

Then(
  'their steady speed is {float} km\\/h to within {float} km\\/h',
  function (this: RidrsWorld, expected: number, within: number) {
    const speed = required(speedResult.get(this), 'a speed') * 3.6;
    assert.ok(Math.abs(speed - expected) <= within, `The speed was ${speed.toFixed(2)} km/h`);
  },
);

const plan = (world: RidrsWorld) => required(scenario(world).plan, 'a plan');
const stretches = (world: RidrsWorld) => plan(world).stretches;
const describe = (list: readonly RefinedStretch[]) =>
  list.map((s) => `${s.from}–${s.to} s ×${s.factor}`).join(', ') || 'none';

function stretch(world: RidrsWorld, n: number): RefinedStretch {
  return required(stretches(world)[n - 1], `refined stretch ${n} of ${describe(stretches(world))}`);
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

Then(/^it has (\d+) refined stretch(?:es)?$/, function (this: RidrsWorld, count: string) {
  assert.equal(stretches(this).length, Number(count), describe(stretches(this)));
});

/** The sample at the middle of the climb, m along the route. */
function middleOfClimb(world: RidrsWorld): RefinementSample {
  const { from, to } = required(scenario(world).climb, 'a climb');
  const middle = (from + to) / 2;
  const samples = plan(world).samples;
  return samples.reduce((best, s) =>
    Math.abs(s.distance - middle) < Math.abs(best.distance - middle) ? s : best,
  );
}

const covering = (world: RidrsWorld, time: number) =>
  stretches(world).find((s) => time >= s.from && time < s.to);

Then(
  'the middle of the climb is refined with {int} frames per frame',
  function (this: RidrsWorld, factor: number) {
    const sample = middleOfClimb(this);
    assert.equal(covering(this, sample.time)?.factor, factor, describe(stretches(this)));
  },
);

Then(
  'at {int} W the rider sees at least {int} frames per second there',
  function (this: RidrsWorld, _power: number, least: number) {
    const sample = middleOfClimb(this);
    const factor = covering(this, sample.time)?.factor ?? 1;
    const seen =
      ((scenario(this).frameRate ?? 0) * factor * sample.riderSpeed) / sample.cameraSpeed;
    assert.ok(seen >= least, `The rider sees ${seen.toFixed(1)} frames per second`);
  },
);

Then(
  'refined stretch {int} runs from {int} s to the end with {int} frames per frame',
  function (this: RidrsWorld, n: number, from: number, factor: number) {
    const found = stretch(this, n);
    const end = scenario(this).track?.points.at(-1)?.time ?? 0;
    assert.ok(
      close(found.from, from) && close(found.to, end) && found.factor === factor,
      describe(stretches(this)),
    );
  },
);

Then(
  'the summary counts {int} in-between frames for {int} frame pairs',
  function (this: RidrsWorld, frames: number, pairs: number) {
    const { summary } = plan(this);
    assert.deepEqual([summary.inBetweenFrames, summary.framePairs], [frames, pairs]);
  },
);

Then(
  'at {int} W the rider sees at least {int} frames per second everywhere',
  function (this: RidrsWorld, _power: number, least: number) {
    const seen = plan(this).summary.lowestSeenAfter;
    assert.ok(seen >= least, `The rider sees ${seen.toFixed(1)} frames per second at least`);
  },
);

const needing = (world: RidrsWorld) => plan(world).samples.filter((s) => s.factor >= 2);

Then(
  'refined stretch {int} begins {float} s before the first moment that needs it',
  function (this: RidrsWorld, n: number, before: number) {
    const first = required(needing(this)[0], 'a moment that needs refining');
    assert.ok(close(stretch(this, n).from, first.time - before), describe(stretches(this)));
  },
);

Then(
  'refined stretch {int} ends {float} s after the last moment that needs it',
  function (this: RidrsWorld, n: number, after: number) {
    const last = required(needing(this).at(-1), 'a moment that needs refining');
    assert.ok(close(stretch(this, n).to, last.time + TIME_STEP + after), describe(stretches(this)));
  },
);

Then(
  /^the moments that need refining leave a gap of (less|more) than (\d+) s$/,
  function (this: RidrsWorld, which: string, seconds: string) {
    const times = needing(this).map((s) => s.time);
    const gaps = times
      .slice(1)
      .map((t, i) => t - (times[i] ?? 0) - TIME_STEP)
      .filter((g) => g > 0);
    assert.equal(gaps.length, 1, `Gaps: ${gaps.join(', ') || 'none'}`);
    const gap = gaps[0] ?? 0;
    assert.ok(
      which === 'less' ? gap < Number(seconds) : gap > Number(seconds),
      `The gap is ${gap} s`,
    );
  },
);

Then(
  'for less than {int} s a rider would need only {int} frames per frame',
  function (this: RidrsWorld, seconds: number, factor: number) {
    const lower = plan(this).samples.filter((s) => s.factor === factor);
    assert.ok(lower.length > 0, 'Expected a moment of the lower factor');
    assert.ok(lower.length * TIME_STEP < seconds, `It lasts ${lower.length * TIME_STEP} s`);
  },
);

Then(
  'refined stretch {int} has {int} frames per frame',
  function (this: RidrsWorld, n: number, factor: number) {
    assert.equal(stretch(this, n).factor, factor, describe(stretches(this)));
  },
);

Then('refined stretch {int} ends at {int} s', function (this: RidrsWorld, n: number, time: number) {
  assert.ok(close(stretch(this, n).to, time), describe(stretches(this)));
});

Then(
  'refined stretch {int} begins at {int} s',
  function (this: RidrsWorld, n: number, time: number) {
    assert.ok(close(stretch(this, n).from, time), describe(stretches(this)));
  },
);

Then(
  'no refined stretch covers the time from {int} s to {int} s',
  function (this: RidrsWorld, from: number, to: number) {
    for (const s of stretches(this)) {
      assert.ok(s.to <= from || s.from >= to, describe(stretches(this)));
    }
  },
);
