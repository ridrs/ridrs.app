// SPDX-License-Identifier: AGPL-3.0-or-later

// Checks the GPX tracks of a video library against the video world's pipeline (ADRs 0062, 0063):
// how plausible each track is, what the pipeline repairs, how smoothly and how accurately the
// picture then moves. Exits with 1 when a route misses a target.
//
//   pnpm check:video-routes [folder …] [--thin-like <gpx>] [--damage <seed>]
//
// The folder defaults to RIDRS_VIDEO_DIR, else `videos` next to the repository. Every .gpx below
// it is a route. Where the track records the GPS speed (`gte:gps speed`), it is the truth for the
// speed error. `--thin-like` also checks every 1-s track thinned to the spacing of that track.
// `--damage` also throws seeded GPS errors into every 1-s track with a recorded speed (a spike
// sideways, a jump, a lag that catches up, in turn every 5 min) and checks that the pipeline
// finds them and keeps the speed right.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Window } from 'happy-dom';
import { parseGpx, type TrackPoint } from '../plugins/ui-world-video/client/library.ts';
import { buildVideoTime, TIME_STEP } from '../plugins/ui-world-video/client/playback.ts';
import { PLAUSIBLE, plausibleTrack, type Repair } from '../plugins/ui-world-video/client/plausible-track.ts';
import { buildTrack, EARTH_RADIUS, type Track } from '../plugins/ui-world-video/client/track.ts';

/** What the picture should do (ADR 0062, section "Measurements"). */
const TARGET = {
  /** % the picture's speed may change across a GPX point, for a rider at a steady speed. */
  rateChange: 7,
  /** % the camera speed may change per second, p95. */
  changePerSecond: 5,
  /** m/s² the picture may imply at most: the plausible longitudinal limit. */
  acceleration: PLAUSIBLE.longitudinal,
  /** m off the plausible track's points, median and p99. */
  offMedian: 2,
  offP99: 5,
};

/** Below this speed (km/h) relative changes and errors say nothing. */
const SLOW = 5;

globalThis.DOMParser = new Window().DOMParser as unknown as typeof DOMParser;

interface Route {
  readonly name: string;
  readonly points: TrackPoint[];
  /** The recorded GPS speed (km/h) at a track time (s), where the track has one. */
  readonly recorded: Map<number, number>;
}

function gpxFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      return gpxFiles(path);
    }
    return entry.name.toLowerCase().endsWith('.gpx') ? [path] : [];
  });
}

function readRoute(path: string, root: string): Route {
  const text = readFileSync(path, 'utf8');
  const points = parseGpx(text);
  const recorded = new Map<number, number>();
  const document = new DOMParser().parseFromString(text, 'application/xml');
  let start: number | undefined;
  for (const point of document.getElementsByTagName('trkpt')) {
    const elements = [...point.getElementsByTagName('*')];
    const at = Date.parse(elements.find((e) => e.localName === 'time')?.textContent ?? '');
    const speed = Number(elements.find((e) => e.localName === 'gps')?.getAttribute('speed') ?? Number.NaN);
    if (!Number.isFinite(at)) {
      continue;
    }
    start ??= at;
    if (Number.isFinite(speed)) {
      recorded.set((at - start) / 1000, speed);
    }
  }
  return { name: relative(root, path), points, recorded };
}

const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
};
const largest = (values: readonly number[]) =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);

/** The camera speed (m/s) at a track time, as a function. */
type Speed = (time: number) => number;

/** Today's mapping before ADR 0062: linear between the raw points. */
function linearSpeed(track: Track): Speed {
  const times = track.points.map((p) => p.time);
  return (time) => {
    let low = 0;
    let high = times.length - 2;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((times[middle] ?? 0) <= time) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const i = low;
    const dt = (times[i + 1] ?? 0) - (times[i] ?? 0);
    return dt > 0 ? ((track.distances[i + 1] ?? 0) - (track.distances[i] ?? 0)) / dt : 0;
  };
}

/** The pipeline: the smoothed video time of the plausible track. */
function pictureOf(track: Track): { distanceAt: (time: number) => number; speed: Speed } {
  const { distances } = buildVideoTime(track);
  const distanceAt = (time: number) => {
    const x = Math.max(0, time / TIME_STEP);
    const i = Math.min(distances.length - 2, Math.floor(x));
    const a = distances[i] ?? 0;
    return a + ((distances[i + 1] ?? a) - a) * (x - i);
  };
  const h = 1 / 60;
  return { distanceAt, speed: (time) => (distanceAt(time + h) - distanceAt(time - h)) / (2 * h) };
}

const fast = (a: number, b: number) => Math.min(a, b) * 3.6 > SLOW;

/** % the speed changes across each inner point of `times`: the step a rider sees there. */
function rateChanges(times: readonly number[], speed: Speed): number[] {
  return times.slice(1, -1).flatMap((t) => {
    const a = speed(t - 1 / 60);
    const b = speed(t + 1 / 60);
    return fast(a, b) ? [Math.abs(a / b - 1) * 100] : [];
  });
}

/** % the speed changes from one second to the next, sampled every frame of 30 fps. */
function changesPerSecond(end: number, speed: Speed): number[] {
  const changes: number[] = [];
  for (let t = 1; t + 1 < end - 1; t += 1 / 30) {
    const a = speed(t);
    const b = speed(t + 1);
    if (fast(a, b)) {
      changes.push(Math.abs(b / a - 1) * 100);
    }
  }
  return changes;
}

/** % off the recorded speed, the camera speed averaged over ±0.5 s around each record. */
function speedErrors(recorded: Map<number, number>, end: number, speed: Speed): number[] {
  return [...recorded].flatMap(([time, truth]) => {
    if (time <= 0 || time >= end || truth < SLOW) {
      return [];
    }
    let sum = 0;
    for (let k = 0; k <= 10; k += 1) {
      sum += speed(time - 0.5 + k / 10);
    }
    return [(Math.abs((sum / 11) * 3.6 - truth) / truth) * 100];
  });
}

/**
 * The accelerations (m/s²) a track implies from fix to fix, along and across the path, GPS noise
 * included: on a 1-s track 1.5 m of noise alone looks like 3 m/s².
 */
function accelerations({ points, distances }: Track): { along: number[]; across: number[] } {
  const along: number[] = [];
  const across: number[] = [];
  const heading = (a: TrackPoint, b: TrackPoint) =>
    Math.atan2((b.longitude - a.longitude) * Math.cos((a.latitude * Math.PI) / 180), b.latitude - a.latitude);
  for (let i = 1; i + 1 < points.length; i += 1) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]] as [TrackPoint, TrackPoint, TrackPoint];
    const d1 = (distances[i] ?? 0) - (distances[i - 1] ?? 0);
    const d2 = (distances[i + 1] ?? 0) - (distances[i] ?? 0);
    const t1 = b.time - a.time;
    const t2 = c.time - b.time;
    if (t1 <= 0 || t2 <= 0) {
      continue;
    }
    const between = (t1 + t2) / 2;
    along.push(Math.abs(d2 / t2 - d1 / t1) / between);
    if (d1 > 1 && d2 > 1) {
      let turn = heading(b, c) - heading(a, b);
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      across.push((Math.abs(turn) * (d1 + d2)) / (t1 + t2) / between);
    }
  }
  return { along, across };
}

/** The largest acceleration (m/s²) the picture implies, from one 0.5-s sample to the next. */
function pictureAcceleration(track: Track): number {
  const { distances } = buildVideoTime(track);
  let most = 0;
  for (let i = 1; i + 1 < distances.length; i += 1) {
    const a = ((distances[i + 1] ?? 0) - 2 * (distances[i] ?? 0) + (distances[i - 1] ?? 0)) / TIME_STEP ** 2;
    most = Math.max(most, Math.abs(a));
  }
  return most;
}

/** Points of a 1-s track kept with the spacing `pattern` (s), repeated; first and last kept. */
function thin(points: readonly TrackPoint[], pattern: readonly number[]): TrackPoint[] {
  const kept = [points[0] as TrackPoint];
  let time = 0;
  for (let k = 0; ; k += 1) {
    time += pattern[k % pattern.length] ?? 1;
    const next = points.find((p) => p.time >= time);
    if (!next || next === points.at(-1)) {
      break;
    }
    if (next !== kept.at(-1)) {
      kept.push(next);
    }
  }
  kept.push(points.at(-1) as TrackPoint);
  return kept;
}

const f = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');

function describeRepairs(repairs: readonly Repair[], effect?: (time: number) => string): string[] {
  const counts = new Map<string, number>();
  for (const repair of repairs) {
    counts.set(repair.kind, (counts.get(repair.kind) ?? 0) + 1);
  }
  const lines = [`  repairs: ${repairs.length === 0 ? 'none' : [...counts].map(([k, n]) => `${n} ${k}`).join(', ')}`];
  for (const repair of repairs.slice(0, 20)) {
    const metres = 'metres' in repair ? ` −${f(repair.metres)} m` : '';
    lines.push(`    ${f(repair.time, 0)} s ${repair.kind}${metres}${effect ? `: ${effect(repair.time)}` : ''}`);
  }
  if (repairs.length > 20) {
    lines.push(`    … ${repairs.length - 20} more`);
  }
  return lines;
}

/** A seeded uniform number in [0, 1). */
const seeded = (seed: number, index: number) =>
  createHash('sha256').update(`${seed}:${index}`).digest().readUInt32BE(0) / 2 ** 32;

/** `point` moved by `east` and `north` m. */
function moved(point: TrackPoint, east: number, north: number): TrackPoint {
  const degrees = 180 / (Math.PI * EARTH_RADIUS);
  return {
    ...point,
    latitude: point.latitude + north * degrees,
    longitude: point.longitude + (east * degrees) / Math.cos((point.latitude * Math.PI) / 180),
  };
}

interface Damage {
  readonly kind: 'spike' | 'jump' | 'lag';
  readonly time: number;
  readonly metres: number;
  /** Whether riding it would need clearly more than the plausible limits: twice as much. */
  readonly implausible: boolean;
}

/** Every 300 s a GPS error, in turn a spike sideways, a jump ahead and a lag that catches up. */
function damaged(points: readonly TrackPoint[], seed: number): { points: TrackPoint[]; damage: Damage[] } {
  const result = [...points];
  const damage: Damage[] = [];
  const kinds = ['spike', 'jump', 'lag'] as const;
  for (let n = 0, i = 300; i + 10 < result.length; n += 1, i += 300) {
    const a = result[i - 1] as TrackPoint;
    const b = result[i + 1] as TrackPoint;
    const east = (b.longitude - a.longitude) * Math.cos((a.latitude * Math.PI) / 180);
    const north = b.latitude - a.latitude;
    const norm = Math.hypot(east, north) || 1;
    const [ue, un] = [east / norm, north / norm];
    const kind = kinds[n % 3] as Damage['kind'];
    const metres = 10 + 20 * seeded(seed, n);
    let implausible = true;
    if (kind === 'spike') {
      result[i] = moved(result[i] as TrackPoint, un * metres, -ue * metres);
    } else if (kind === 'jump') {
      for (let j = i; j < result.length; j += 1) {
        result[j] = moved(result[j] as TrackPoint, ue * metres, un * metres);
      }
    } else {
      const run = 3 + Math.floor(4 * seeded(seed, 1000 + n));
      // The lag's shape is half a sine over the run: its largest acceleration is metres · (π / T)².
      implausible = metres * (Math.PI / (run + 1)) ** 2 > 2 * PLAUSIBLE.longitudinal;
      for (let k = 0; k < run; k += 1) {
        const lag = metres * Math.sin((Math.PI * (k + 1)) / (run + 1));
        result[i + k] = moved(result[i + k] as TrackPoint, -ue * lag, -un * lag);
      }
    }
    damage.push({ kind, time: (result[i] as TrackPoint).time, metres, implausible });
  }
  return { points: result, damage };
}

/** How the pipeline copes with the damage: found, missed, and the speed error it leaves. */
function checkDamage(route: Route, seed: number, result: (label: string, ok: boolean) => void): void {
  const { points, damage } = damaged(route.points, seed);
  const before = new Set(plausibleTrack(route.points).repairs.map((r) => r.time));
  const { track, repairs } = plausibleTrack(points);
  const fresh = repairs.filter((r) => !before.has(r.time));
  const found = damage.filter((d) => fresh.some((r) => r.time >= d.time - 2 && r.time <= d.time + 8));
  const stray = fresh.filter((r) => !damage.some((d) => r.time >= d.time - 2 && r.time <= d.time + 8));
  const end = track.points.at(-1)?.time ?? 0;
  const errors = speedErrors(route.recorded, end, pictureOf(track).speed);
  const unrepaired = speedErrors(route.recorded, end, pictureOf(buildTrack(points)).speed);
  const clean = speedErrors(route.recorded, end, pictureOf(plausibleTrack(route.points).track).speed);
  const implausible = damage.filter((d) => d.implausible);
  const missed = implausible.filter((d) => !found.includes(d));
  console.log(
    `  damage (seed ${seed}): ${damage.length} errors of 10–30 m, ${implausible.length} beyond the limits; found ${found.length}, ${stray.length} repairs elsewhere`,
  );
  for (const d of damage.filter((x) => !found.includes(x))) {
    console.log(`    missed ${d.kind} of ${f(d.metres)} m at ${f(d.time, 0)} s${d.implausible ? '' : ' (within the limits)'}`);
  }
  result(
    `damaged: every error beyond the limits found; speed error p99 ${f(quantile(errors, 0.99))} % < unrepaired ${f(quantile(unrepaired, 0.99))} % (undamaged ${f(quantile(clean, 0.99))} %), p99.9 ${f(quantile(errors, 0.999))} % (unrepaired ${f(quantile(unrepaired, 0.999))} %)`,
    missed.length === 0 && quantile(errors, 0.99) < quantile(unrepaired, 0.99),
  );
}

function check(route: Route, thinLike: number[] | undefined, damageSeed: number | undefined): boolean {
  const { points, recorded } = route;
  const raw = buildTrack(points);
  const { track, repairs } = plausibleTrack(points);
  const picture = pictureOf(track);
  const linear = linearSpeed(raw);
  const times = track.points.map((p) => p.time);
  const end = times.at(-1) ?? 0;
  const spacing = points.slice(1).map((p, i) => p.time - (points[i] as TrackPoint).time);
  const raw3 = accelerations(raw);
  const plausible3 = accelerations(track);
  const off = times.map((t, i) => Math.abs(picture.distanceAt(t) - (track.distances[i] ?? 0)));
  const rate = rateChanges(times, picture.speed);
  const perSecond = changesPerSecond(end, picture.speed);
  const acceleration = pictureAcceleration(track);

  console.log(`\n${route.name}`);
  console.log(
    `  ${points.length} points over ${f(end / 60)} min, ${f(raw.length / 1000, 2)} km; spacing median ${f(quantile(spacing, 0.5))} s, p95 ${f(quantile(spacing, 0.95))} s, max ${f(largest(spacing))} s`,
  );
  console.log(
    `  fix to fix along ${f(quantile(raw3.along, 0.999))} m/s² p99.9, ${f(largest(raw3.along))} max; across ${f(quantile(raw3.across, 0.999))} p99.9, ${f(largest(raw3.across))} max (limits ${PLAUSIBLE.longitudinal}, ${PLAUSIBLE.lateral}; after repair ${f(largest(plausible3.along))}, ${f(largest(plausible3.across))})`,
  );
  // What a repair does to the speed error nearby: linear, smoothed without repairs, the pipeline.
  const smoothedRaw = pictureOf(raw).speed;
  const near = (time: number) => new Map([...recorded].filter(([t]) => Math.abs(t - time) <= 10));
  const effect =
    recorded.size > 0
      ? (time: number) =>
          `worst speed error ±10 s ${[linear, smoothedRaw, picture.speed]
            .map((speed) => f(largest(speedErrors(near(time), end, speed)), 0))
            .join(' → ')} %`
      : undefined;
  for (const line of describeRepairs(repairs, effect)) {
    console.log(line);
  }
  console.log(`  length ${f(raw.length)} m → ${f(track.length)} m`);

  const results: [string, boolean][] = [];
  const result = (label: string, ok: boolean) => {
    results.push([label, ok]);
  };
  const linearRate = rateChanges(raw.points.map((p) => p.time), linear);
  result(
    `rate change across a point ${f(largest(rate))} % (linear ${f(largest(linearRate))} %) ≤ ${TARGET.rateChange} %`,
    largest(rate) <= TARGET.rateChange,
  );
  result(
    `speed change per second p95 ${f(quantile(perSecond, 0.95))} % (linear ${f(quantile(changesPerSecond(end, linear), 0.95))} %) ≤ ${TARGET.changePerSecond} %`,
    quantile(perSecond, 0.95) <= TARGET.changePerSecond,
  );
  result(`picture acceleration ${f(acceleration, 2)} m/s² ≤ ${TARGET.acceleration}`, acceleration <= TARGET.acceleration);
  result(
    `off the points median ${f(quantile(off, 0.5), 2)} m ≤ ${TARGET.offMedian}, p99 ${f(quantile(off, 0.99), 2)} m ≤ ${TARGET.offP99} (max ${f(largest(off))} m)`,
    quantile(off, 0.5) <= TARGET.offMedian && quantile(off, 0.99) <= TARGET.offP99,
  );
  if (recorded.size > 0) {
    const errors = speedErrors(recorded, end, picture.speed);
    const linearErrors = speedErrors(recorded, end, linear);
    const truth = [...recorded].reduce(
      (sum, [time, speed], i, all) => (i === 0 ? 0 : sum + ((speed + (all[i - 1]?.[1] ?? speed)) / 7.2) * (time - (all[i - 1]?.[0] ?? time))),
      0,
    );
    result(
      `speed error p95 ${f(quantile(errors, 0.95))} % < linear ${f(quantile(linearErrors, 0.95))} % (p99 ${f(quantile(errors, 0.99))} %, p99.9 ${f(quantile(errors, 0.999))} %; track ${f((track.length / truth - 1) * 100, 2)} % longer than the recorded speed rode)`,
      quantile(errors, 0.95) < quantile(linearErrors, 0.95),
    );
    if (thinLike && quantile(spacing, 0.95) <= 1) {
      const thinned = thin(points, thinLike);
      const thinnedTrack = plausibleTrack(thinned).track;
      const thinnedErrors = speedErrors(recorded, end, pictureOf(thinnedTrack).speed);
      const thinnedLinear = speedErrors(recorded, end, linearSpeed(buildTrack(thinned)));
      result(
        `thinned to ${thinned.length} points: speed error p95 ${f(quantile(thinnedErrors, 0.95))} % < linear ${f(quantile(thinnedLinear, 0.95))} %`,
        quantile(thinnedErrors, 0.95) < quantile(thinnedLinear, 0.95),
      );
    }
    if (damageSeed !== undefined && quantile(spacing, 0.95) <= 1) {
      checkDamage(route, damageSeed, result);
    }
  }
  for (const [label, ok] of results) {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}`);
  }
  return results.every(([, ok]) => ok);
}

const args = process.argv.slice(2);
const thinIndex = args.indexOf('--thin-like');
const thinPath = thinIndex >= 0 ? args.splice(thinIndex, 2)[1] : undefined;
const damageIndex = args.indexOf('--damage');
const damageSeed = damageIndex >= 0 ? Number(args.splice(damageIndex, 2)[1]) : undefined;
const folders = args.length > 0 ? args : [process.env.RIDRS_VIDEO_DIR ?? resolve(import.meta.dirname, '../../videos')];
const thinLike = thinPath
  ? (() => {
      const points = parseGpx(readFileSync(thinPath, 'utf8'));
      return points.slice(1).map((p, i) => p.time - (points[i] as TrackPoint).time).filter((dt) => dt > 0);
    })()
  : undefined;

let failed = 0;
let count = 0;
for (const folder of folders) {
  for (const path of gpxFiles(folder)) {
    count += 1;
    if (!check(readRoute(path, folder), thinLike, damageSeed)) {
      failed += 1;
    }
  }
}
console.log(`\n${count} routes, ${failed} missing a target`);
process.exitCode = failed > 0 ? 1 : 0;
