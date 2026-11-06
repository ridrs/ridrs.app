// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import type { TrackPoint } from '../../plugins/ui-world-video/client/library.ts';
import {
  buildVideoTime,
  type VideoTime,
  videoTimeAt,
} from '../../plugins/ui-world-video/client/playback.ts';
import { buildTrack, type Track } from '../../plugins/ui-world-video/client/track.ts';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The video time of the video world, headless: synthetic GPX tracks due north, the smoothed
 * table built from them and a rider who rides them at a steady speed.
 */

interface Scenario {
  track: Track;
  table: VideoTime;
  offset: number;
  /** Where the camera stood still, m along the track. */
  standstill?: number;
  /** The video time at every sample of the rider's ride, s. */
  ridden?: number[];
  /** The rider's time between two samples, s. */
  riddenStep?: number;
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  const found = scenarios.get(world);
  assert.ok(found, 'Expected a track');
  return found;
}

/** m along the meridian per degree of latitude, as the haversine distance has it near 45° N. */
const METRES_PER_DEGREE = 111_195;

export const kmh = (speed: number) => speed / 3.6;

/** Points due north from 45° N, 5° E, one at each of `times` (s) at `distances` (m). */
function northbound(times: readonly number[], distances: readonly number[]): TrackPoint[] {
  return times.map((time, i) => ({
    latitude: 45 + (distances[i] ?? 0) / METRES_PER_DEGREE,
    longitude: 5,
    elevation: 100,
    time,
  }));
}

/** A track with a point every second, whose camera moves at `speedAt(t)` m/s. */
function filmed(
  duration: number,
  speedAt: (time: number) => number,
): { times: number[]; distances: number[] } {
  const times = [0];
  const distances = [0];
  for (let t = 1; t <= duration; t += 1) {
    times.push(t);
    distances.push((distances.at(-1) ?? 0) + speedAt(t - 1));
  }
  return { times, distances };
}

/** Uses the track of `points`; the camera stood still at the point `standstill`, if any. */
function useTrack(world: RidrsWorld, points: TrackPoint[], standstill?: number): void {
  const track = buildTrack(points);
  scenarios.set(world, {
    track,
    table: buildVideoTime(track),
    offset: 0,
    standstill: standstill === undefined ? undefined : track.distances[standstill],
  });
}

/** A seeded uniform number in [0, 1): deterministic, from a hash of the seed and the index. */
export function seeded(seed: number, index: number): number {
  return createHash('sha256').update(`${seed}:${index}`).digest().readUInt32BE(0) / 2 ** 32;
}

Given(
  'a track filmed with a point every second at {int} km\\/h for {int} s and then at {int} km\\/h for {int} s',
  function (this: RidrsWorld, first: number, firstFor: number, second: number, secondFor: number) {
    const { times, distances } = filmed(firstFor + secondFor, (t) =>
      kmh(t < firstFor ? first : second),
    );
    useTrack(this, northbound(times, distances));
  },
);

Given(
  'a track filmed with a point every second at a steady {int} km\\/h for {int} s, each point off by up to {int} m with the seed {int}',
  function (this: RidrsWorld, speed: number, duration: number, noise: number, seed: number) {
    const { times, distances } = filmed(duration, () => kmh(speed));
    const jittered = distances.map((d, i) => d + (2 * seeded(seed, i) - 1) * noise);
    useTrack(this, northbound(times, jittered));
  },
);

Given(
  'a track filmed with a point every second at {int} km\\/h for {int} s, three points standing still until {int} s and again at {int} km\\/h for {int} s',
  function (
    this: RidrsWorld,
    speed: number,
    before: number,
    until: number,
    again: number,
    after: number,
  ) {
    const first = filmed(before, () => kmh(speed));
    const standstill = first.distances.at(-1) ?? 0;
    const times = [...first.times, (before + until) / 2, until];
    const distances = [...first.distances, standstill, standstill];
    for (let t = 1; t <= after; t += 1) {
      times.push(until + t);
      distances.push(standstill + kmh(again) * t);
    }
    useTrack(this, northbound(times, distances), first.times.length - 1);
  },
);

Given(
  'a track filmed with a point every second at {int} km\\/h for {int} s',
  function (this: RidrsWorld, speed: number, duration: number) {
    const { times, distances } = filmed(duration, () => kmh(speed));
    useTrack(this, northbound(times, distances));
  },
);

Given('the track starts {int} s into the video', function (this: RidrsWorld, offset: number) {
  scenario(this).offset = offset;
});

When('a rider rides it at a steady {int} km\\/h', function (this: RidrsWorld, speed: number) {
  const current = scenario(this);
  const step = 0.5;
  const ridden: number[] = [];
  for (let t = 0; kmh(speed) * t <= current.track.length; t += step) {
    ridden.push(videoTimeAt(current.table, kmh(speed) * t, current.offset));
  }
  current.ridden = ridden;
  current.riddenStep = step;
});

/** The video's rate over every `every` s of the rider's ride, video s per rider s. */
function rates(current: Scenario, every: number): number[] {
  const { ridden = [], riddenStep = 1 } = current;
  const stride = Math.round(every / riddenStep);
  const result: number[] = [];
  for (let i = stride; i < ridden.length; i += stride) {
    result.push(((ridden[i] ?? 0) - (ridden[i - stride] ?? 0)) / every);
  }
  return result;
}

/** The relative change of the rate from one span to the next, leaving out the held end. */
function changes(rateList: readonly number[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < rateList.length; i += 1) {
    const a = rateList[i - 1] ?? 0;
    const b = rateList[i] ?? 0;
    if (a > 0 && b > 0) {
      result.push(Math.abs(b / a - 1));
    }
  }
  return result;
}

Then(
  "the video's rate changes by at most {int} % from one 0.5-s sample to the next",
  function (this: RidrsWorld, percent: number) {
    const largest = Math.max(...changes(rates(scenario(this), 0.5)));
    assert.ok(largest <= percent / 100, `The rate changed by ${(largest * 100).toFixed(2)} %`);
  },
);

Then(
  "the video's rate changes by at most {int} % per second in {int} % of the seconds",
  function (this: RidrsWorld, percent: number, share: number) {
    const sorted = changes(rates(scenario(this), 1)).sort((a, b) => a - b);
    const quantile = sorted[Math.ceil((share / 100) * sorted.length) - 1] ?? 0;
    assert.ok(
      quantile <= percent / 100,
      `The rate changed by ${(quantile * 100).toFixed(2)} % at the ${share}th percentile`,
    );
  },
);

Then('the video time never decreases', function (this: RidrsWorld) {
  const { ridden = [] } = scenario(this);
  assert.ok(ridden.length > 1, 'Expected a ride');
  ridden.forEach((time, i) => {
    assert.ok(i === 0 || time >= (ridden[i - 1] ?? 0), `The video ran backwards at sample ${i}`);
  });
});

Then(
  "at the standstill's distance the video time lies between {int} s and {int} s",
  function (this: RidrsWorld, from: number, to: number) {
    const current = scenario(this);
    const time = videoTimeAt(current.table, current.standstill ?? Number.NaN, current.offset);
    assert.ok(time >= from && time <= to, `The video time was ${time} s`);
  },
);

Then(
  "{int} m before the standstill's distance the video time is at most {int} s",
  function (this: RidrsWorld, before: number, most: number) {
    const current = scenario(this);
    const time = videoTimeAt(
      current.table,
      (current.standstill ?? Number.NaN) - before,
      current.offset,
    );
    assert.ok(time <= most, `The video time was ${time} s`);
  },
);

function assertTimeAt(
  world: RidrsWorld,
  distance: (track: Track) => number,
  expected: number,
): void {
  const current = scenario(world);
  const time = videoTimeAt(current.table, distance(current.track), current.offset);
  assert.ok(
    Math.abs(time - expected) < 1e-6,
    `The video time was ${time} s, expected ${expected} s`,
  );
}

Then(
  '{int} m before the start the video time is {int} s',
  function (this: RidrsWorld, before: number, expected: number) {
    assertTimeAt(this, () => -before, expected);
  },
);

Then('at the start the video time is {int} s', function (this: RidrsWorld, expected: number) {
  assertTimeAt(this, () => 0, expected);
});

Then(
  '{int} m beyond the end the video time is {int} s',
  function (this: RidrsWorld, beyond: number, expected: number) {
    assertTimeAt(this, (track) => track.length + beyond, expected);
  },
);
