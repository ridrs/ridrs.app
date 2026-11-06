// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { TrackPoint } from '../../plugins/ui-world-video/client/library.ts';
import {
  type PlausibleTrack,
  plausibleTrack,
} from '../../plugins/ui-world-video/client/plausible-track.ts';
import { buildVideoTime, videoTimeAt } from '../../plugins/ui-world-video/client/playback.ts';
import { buildTrack } from '../../plugins/ui-world-video/client/track.ts';
import type { RidrsWorld } from '../support/world.ts';
import { kmh, seeded } from './video-time.steps.ts';

/*
 * The plausibility of a GPX track, headless: synthetic rides in local metres (x east, y north)
 * around 45° N, 5° E, the camera's true path next to what the GPS recorded.
 */

/** A fix in local metres, at a time in s. */
interface Fix {
  x: number;
  y: number;
  time: number;
}

interface Scenario {
  /** Where the camera really was. */
  truth: Fix[];
  /** What the GPS recorded. */
  recorded: Fix[];
  plausible?: PlausibleTrack;
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  const found = scenarios.get(world);
  assert.ok(found, 'Expected a track');
  return found;
}

function plausible(world: RidrsWorld): PlausibleTrack {
  const found = scenario(world).plausible;
  assert.ok(found, 'Expected the track to be made plausible');
  return found;
}

/** m per degree of latitude, as the haversine distance has it. */
const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

const toPoints = (fixes: readonly Fix[]): TrackPoint[] =>
  fixes.map(({ x, y, time }) => ({
    latitude: 45 + y / METRES_PER_DEGREE,
    longitude: 5 + x / (METRES_PER_DEGREE * Math.cos((45 * Math.PI) / 180)),
    elevation: 100,
    time,
  }));

function useRide(world: RidrsWorld, truth: Fix[]): void {
  scenarios.set(world, { truth, recorded: truth.map((fix) => ({ ...fix })) });
}

/** A ride sampled every `every` s from a path: `at(t)` is where the camera is at `t` s. */
function sampled(
  duration: number,
  every: number,
  at: (time: number) => { x: number; y: number },
): Fix[] {
  return Array.from({ length: Math.floor(duration / every) + 1 }, (_, i) => ({
    ...at(i * every),
    time: i * every,
  }));
}

/** Straight due north, then a half circle of `radius` m to the east, then straight back south. */
function hairpin(radius: number, speed: number, straight: number) {
  const before = speed * straight;
  const turn = (Math.PI * radius) / speed;
  return {
    duration: 2 * straight + turn,
    at: (t: number) => {
      if (t <= straight) {
        return { x: 0, y: speed * t };
      }
      if (t <= straight + turn) {
        const angle = ((t - straight) * speed) / radius;
        return { x: radius - radius * Math.cos(angle), y: before + radius * Math.sin(angle) };
      }
      return { x: 2 * radius, y: before - speed * (t - straight - turn) };
    },
  };
}

Given(
  'a straight track filmed at {int} km\\/h for {int} s with a point every second',
  function (this: RidrsWorld, speed: number, duration: number) {
    useRide(
      this,
      sampled(duration, 1, (t) => ({ x: 0, y: kmh(speed) * t })),
    );
  },
);

/** The recorded fix at `time` s. */
function recordedAt(world: RidrsWorld, time: number): Fix {
  const fix = scenario(world).recorded.find((candidate) => candidate.time === time);
  assert.ok(fix, `Expected a point at ${time} s`);
  return fix;
}

Given('the point at {int} s repeated', function (this: RidrsWorld, time: number) {
  const { recorded } = scenario(this);
  const i = recorded.findIndex((fix) => fix.time === time);
  recorded.splice(i + 1, 0, { ...(recorded[i] as Fix) });
});

Given(
  'the point at {int} s thrown {int} m sideways',
  function (this: RidrsWorld, time: number, metres: number) {
    recordedAt(this, time).x += metres;
  },
);

Given(
  'the point at {int} s thrown {int} m back along the road',
  function (this: RidrsWorld, time: number, metres: number) {
    recordedAt(this, time).y -= metres;
  },
);

Given(
  'every point from {int} s on shifted {int} m ahead along the road',
  function (this: RidrsWorld, from: number, metres: number) {
    for (const fix of scenario(this).recorded) {
      if (fix.time >= from) {
        fix.y += metres;
      }
    }
  },
);

Given(
  'the points from {int} s to {int} s lagging {int}, {int}, {int} and {int} m behind',
  function (
    this: RidrsWorld,
    from: number,
    to: number,
    a: number,
    b: number,
    c: number,
    d: number,
  ) {
    const lags = [a, b, c, d];
    assert.equal(lags.length, to - from + 1, 'Expected one lag per point');
    lags.forEach((lag, i) => {
      recordedAt(this, from + i).y -= lag;
    });
  },
);

Given(
  'a track of a hairpin of {int} m radius at {int} km\\/h with a point every second',
  function (this: RidrsWorld, radius: number, speed: number) {
    const { duration, at } = hairpin(radius, kmh(speed), 60);
    useRide(this, sampled(duration, 1, at));
  },
);

Given(
  'a track of a hairpin of {int} m radius at {int} km\\/h with a point every {int} s',
  function (this: RidrsWorld, radius: number, speed: number, every: number) {
    const { duration, at } = hairpin(radius, kmh(speed), 60);
    useRide(this, sampled(duration, every, at));
  },
);

Given(
  'a track of braking from {int} km\\/h to a stop at {int} m\\/s² with a point every second',
  function (this: RidrsWorld, speed: number, deceleration: number) {
    const v = kmh(speed);
    const stop = v / deceleration;
    const braked = (v * v) / (2 * deceleration);
    // 60 s steady, braking to a stop, 10 s standing, then away again as hard.
    const at = (t: number) => {
      if (t <= 60) {
        return { x: 0, y: v * t };
      }
      if (t <= 60 + stop) {
        const s = t - 60;
        return { x: 0, y: 60 * v + v * s - (deceleration * s * s) / 2 };
      }
      if (t <= 70 + stop) {
        return { x: 0, y: 60 * v + braked };
      }
      const s = Math.min(t - 70 - stop, stop);
      const cruise = Math.max(0, t - 70 - 2 * stop);
      return { x: 0, y: 60 * v + braked + (deceleration * s * s) / 2 + v * cruise };
    };
    useRide(this, sampled(140 + 2 * stop, 1, at));
  },
);

Given(
  'a track of a curve of {int} m radius at {int} km\\/h with a point every second',
  function (this: RidrsWorld, radius: number, speed: number) {
    const v = kmh(speed);
    // A quarter circle between two straights of 30 s.
    const turn = (Math.PI * radius) / 2 / v;
    const at = (t: number) => {
      if (t <= 30) {
        return { x: 0, y: v * t };
      }
      if (t <= 30 + turn) {
        const angle = ((t - 30) * v) / radius;
        return { x: radius - radius * Math.cos(angle), y: 30 * v + radius * Math.sin(angle) };
      }
      return { x: radius + v * (t - 30 - turn), y: 30 * v + radius };
    };
    useRide(this, sampled(60 + turn, 1, at));
  },
);

Given(
  'a track of a steady {int} km\\/h with every point off by up to {int} m with the seed {int}',
  function (this: RidrsWorld, speed: number, metres: number, seed: number) {
    useRide(
      this,
      sampled(300, 1, (t) => ({ x: 0, y: kmh(speed) * t })),
    );
    scenario(this).recorded.forEach((fix, i) => {
      fix.x += (2 * seeded(seed, 2 * i) - 1) * metres;
      fix.y += (2 * seeded(seed, 2 * i + 1) - 1) * metres;
    });
  },
);

When('the track is made plausible', function (this: RidrsWorld) {
  const current = scenario(this);
  current.plausible = plausibleTrack(toPoints(current.recorded));
});

const repairsOf = (world: RidrsWorld, kind: string) =>
  plausible(world).repairs.filter((r) => r.kind === kind);

Then(
  '{int} point(s) is/are dropped as {string}',
  function (this: RidrsWorld, count: number, kind: string) {
    assert.equal(repairsOf(this, kind).length, count, JSON.stringify(plausible(this).repairs));
  },
);

Then(
  'the point at {int} s is dropped as {string}',
  function (this: RidrsWorld, time: number, kind: string) {
    assert.deepEqual(
      repairsOf(this, kind).map((r) => r.time),
      [time],
      JSON.stringify(plausible(this).repairs),
    );
  },
);

Then(
  'the points from {int} s to {int} s are dropped as {string}',
  function (this: RidrsWorld, from: number, to: number, kind: string) {
    assert.deepEqual(
      repairsOf(this, kind).map((r) => r.time),
      Array.from({ length: to - from + 1 }, (_, i) => from + i),
      JSON.stringify(plausible(this).repairs),
    );
  },
);

Then(
  'a jump of {int} m at {int} s is taken out, within {int} m',
  function (this: RidrsWorld, metres: number, time: number, within: number) {
    const jumps = plausible(this).repairs.filter((r) => r.kind === 'jump');
    assert.equal(jumps.length, 1, JSON.stringify(plausible(this).repairs));
    const [jump] = jumps;
    assert.equal(jump?.time, time);
    assert.ok(
      Math.abs((jump && 'metres' in jump ? jump.metres : 0) - metres) <= within,
      JSON.stringify(jump),
    );
  },
);

Then(
  'the track is as long as the camera rode, within {float} m',
  function (this: RidrsWorld, within: number) {
    const current = scenario(this);
    const rode = buildTrack(toPoints(current.truth)).length;
    const length = plausible(this).track.length;
    assert.ok(
      Math.abs(length - rode) <= within,
      `The track is ${length} m, the camera rode ${rode} m`,
    );
  },
);

Then(
  "a rider at a steady {int} km\\/h sees the video at the camera's speed, within {int} %",
  function (this: RidrsWorld, speed: number, percent: number) {
    const { track } = plausible(this);
    const table = buildVideoTime(track);
    const step = 0.5;
    let previous = videoTimeAt(table, 0);
    for (let t = step; kmh(speed) * t <= track.length; t += step) {
      const time = videoTimeAt(table, kmh(speed) * t);
      const rate = (time - previous) / step;
      assert.ok(
        Math.abs(rate - 1) <= percent / 100,
        `At ${t} s the video ran at ${(rate * 100).toFixed(1)} %`,
      );
      previous = time;
    }
  },
);

Then('nothing is repaired', function (this: RidrsWorld) {
  const { repairs, track } = plausible(this);
  assert.deepEqual(repairs, []);
  assert.equal(track.points.length, scenario(this).recorded.length);
});
