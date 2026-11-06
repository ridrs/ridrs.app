// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TrackPoint } from './library.ts';
import { buildTrack, EARTH_RADIUS, haversine, type Track } from './track.ts';

/**
 * What a ride filmed from a bicycle or a camera motorbike can do, and how far GPS fixes wander
 * (ADR 0063). A fix that would need more is a GPS error.
 */
export const PLAUSIBLE = {
  /** m/s², braking or speeding up: 0.4 g, harder than a bicycle brakes on a road. */
  longitudinal: 4,
  /** m/s² across the path in a curve: 0.5 g, a bicycle leaning 27°. */
  lateral: 5,
  /** m a fix may lie off its neighbours by noise alone, from one fix to the next. */
  position: 1.5,
  /** m/s a segment's speed may be off by noise alone. */
  speed: 1.5,
} as const;

/**
 * What was repaired, at the point's time (s): a point out of time order, thrown sideways or
 * backwards (`spike`) or lagging behind and catching up (`lag`) is dropped; a jump of the GPS is
 * taken out of the distance, by `metres`.
 */
export type Repair =
  | { readonly kind: 'time' | 'spike' | 'lag'; readonly time: number }
  | { readonly kind: 'jump'; readonly time: number; readonly metres: number };

export interface PlausibleTrack {
  readonly track: Track;
  readonly repairs: readonly Repair[];
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Where `point` lies from `origin`, in m east and north. */
function offset(origin: TrackPoint, point: TrackPoint): [number, number] {
  return [
    EARTH_RADIUS * radians(point.longitude - origin.longitude) * Math.cos(radians(origin.latitude)),
    EARTH_RADIUS * radians(point.latitude - origin.latitude),
  ];
}

/**
 * How far a point between two neighbours may lie off the path between them at a constant
 * acceleration `limit`, plus the noise: `limit · t₁ · t₂ / 2 + position`. Between distant
 * neighbours a point may lie further off.
 */
const allowed = (limit: number, before: number, after: number) =>
  (limit * before * after) / 2 + PLAUSIBLE.position;

/**
 * s either side of a fast segment within which slow segments make up for it: a GPS that lagged
 * and catches up, not a jump.
 */
const MAKE_UP = 5;

/** How many points in a row may be dropped at most: a GPS that lags for a few seconds. */
const LONGEST_RUN = 11;

/**
 * Drops the fewest points such that `excess` finds every point plausible (at most 1) between
 * the neighbours it is left with; of equally many, the one that fits best. Dynamic programming
 * over pairs of consecutive kept points, at most `LONGEST_RUN` dropped in a row. The first and
 * the last point stay. Where no such choice exists, nothing is dropped.
 */
function dropImplausible(
  alive: boolean[],
  excess: (before: number, point: number, after: number) => number,
  dropped: (point: number) => void,
): void {
  const candidates = alive.flatMap((isAlive, i) => (isAlive ? [i] : []));
  const m = candidates.length;
  if (m < 3) {
    return;
  }
  const reach = LONGEST_RUN + 1;
  // State (p, q) at q * reach + s, with p = q - 1 - s: the best chain from the first point
  // that ends with p and q, its length (0: none), its summed excess and its state at p.
  const count = new Int32Array(m * reach);
  const cost = new Float64Array(m * reach);
  const from = new Int32Array(m * reach).fill(-1);
  for (let q = 1; q <= Math.min(reach, m - 1); q += 1) {
    count[q * reach + q - 1] = 2;
  }
  for (let q = 1; q < m - 1; q += 1) {
    for (let s = 0; s < reach && q - 1 - s >= 0; s += 1) {
      const here = q * reach + s;
      if (count[here] === 0) {
        continue;
      }
      const p = candidates[q - 1 - s] as number;
      for (let r = q + 1; r <= Math.min(m - 1, q + reach); r += 1) {
        const e = excess(p, candidates[q] as number, candidates[r] as number);
        if (e > 1) {
          continue;
        }
        const there = r * reach + (r - 1 - q);
        const length = (count[here] as number) + 1;
        const total = (cost[here] as number) + e;
        if (length > (count[there] as number) || (length === count[there] && total < (cost[there] as number))) {
          count[there] = length;
          cost[there] = total;
          from[there] = s;
        }
      }
    }
  }
  let best = -1;
  for (let s = 0; s < reach; s += 1) {
    const end = (m - 1) * reach + s;
    if (
      (count[end] as number) > 0 &&
      (best < 0 ||
        (count[end] as number) > (count[(m - 1) * reach + best] as number) ||
        (count[end] === count[(m - 1) * reach + best] && (cost[end] as number) < (cost[(m - 1) * reach + best] as number)))
    ) {
      best = s;
    }
  }
  if (best < 0) {
    return;
  }
  const chain = new Set<number>([m - 1]);
  for (let q = m - 1, s = best; ; ) {
    const p = q - 1 - s;
    chain.add(p);
    if (p === 0) {
      break;
    }
    s = from[q * reach + s] as number;
    q = p;
  }
  candidates.forEach((i, k) => {
    if (!chain.has(k)) {
      alive[i] = false;
      dropped(i);
    }
  });
}

/**
 * The track of a route's GPX points, made plausible first (ADR 0063):
 *
 * 1. a point whose time doesn't increase is dropped;
 * 2. a point thrown sideways off the path between its neighbours, or backwards or forwards
 *    beyond them, further than `PLAUSIBLE.lateral` or `PLAUSIBLE.longitudinal` allow, is
 *    dropped (`spike`);
 * 3. a single segment far faster than its neighbours, which agree with each other, and not made
 *    up for by slow segments within `MAKE_UP` s, is a jump of the GPS: it counts with their
 *    speed (`jump`); the points stay where they are;
 * 4. a point whose distance lies off the steady progress between its neighbours further than
 *    `PLAUSIBLE.longitudinal` allows is dropped (`lag`): a run of fixes that lags behind and
 *    catches up is bridged.
 */
export function plausibleTrack(points: readonly TrackPoint[]): PlausibleTrack {
  const repairs: Repair[] = [];
  const at = (i: number) => points[i] as TrackPoint;
  const alive = points.map(() => true);
  let latest = Number.NEGATIVE_INFINITY;
  points.forEach((point, i) => {
    if (point.time <= latest) {
      alive[i] = false;
      repairs.push({ kind: 'time', time: point.time });
    } else {
      latest = point.time;
    }
  });

  dropImplausible(
    alive,
    (h, i, j) => {
      const before = at(i).time - at(h).time;
      const after = at(j).time - at(i).time;
      const [hx, hy] = offset(at(i), at(h));
      const [jx, jy] = offset(at(i), at(j));
      const chord = Math.hypot(jx - hx, jy - hy);
      if (chord === 0) {
        return Math.hypot(hx, hy) / allowed(PLAUSIBLE.lateral, before, after);
      }
      const ux = (jx - hx) / chord;
      const uy = (jy - hy) / chord;
      const along = -hx * ux - hy * uy;
      const across = Math.abs(-hx * uy + hy * ux);
      const beyond = Math.max(0, -along, along - chord);
      return Math.max(
        across / allowed(PLAUSIBLE.lateral, before, after),
        beyond / allowed(PLAUSIBLE.longitudinal, before, after),
      );
    },
    (i) => repairs.push({ kind: 'spike', time: at(i).time }),
  );

  const kept = alive.flatMap((isAlive, i) => (isAlive ? [i] : []));
  if (kept.length < 2) {
    return { track: buildTrack(kept.map(at)), repairs };
  }
  const lengths = kept.slice(1).map((i, k) => haversine(at(kept[k] as number), at(i)));
  const durations = kept.slice(1).map((i, k) => at(i).time - at(kept[k] as number).time);
  const speeds = lengths.map((length, k) => length / (durations[k] as number));
  const middle = (k: number) => at(kept[k] as number).time + (durations[k] as number) / 2;
  /** m the segments within `MAKE_UP` s of segment `k` fall short of `speed`. */
  const madeUp = (k: number, speed: number) => {
    let short = 0;
    for (let j = 0; j < lengths.length; j += 1) {
      if (j !== k && Math.abs(middle(j) - middle(k)) <= MAKE_UP) {
        short += Math.max(0, speed * (durations[j] as number) - (lengths[j] as number));
      }
    }
    return short;
  };
  for (let k = 2; k < speeds.length - 2; k += 1) {
    const before = speeds[k - 1] as number;
    const after = speeds[k + 1] as number;
    const around = [speeds[k - 2] as number, before, after, speeds[k + 2] as number];
    const gap = Math.max(middle(k) - middle(k - 1), middle(k + 1) - middle(k));
    const span = middle(k + 2) - middle(k - 2);
    if (
      (speeds[k] as number) - Math.max(before, after) > PLAUSIBLE.longitudinal * gap + PLAUSIBLE.speed &&
      Math.max(...around) - Math.min(...around) <= PLAUSIBLE.longitudinal * span + PLAUSIBLE.speed
    ) {
      const neighbours = (lengths[k - 1] as number) + (lengths[k + 1] as number);
      const speed = neighbours / ((durations[k - 1] as number) + (durations[k + 1] as number));
      const length = speed * (durations[k] as number);
      if (madeUp(k, speed) >= ((lengths[k] as number) - length) / 2) {
        continue;
      }
      repairs.push({ kind: 'jump', time: at(kept[k + 1] as number).time, metres: (lengths[k] as number) - length });
      lengths[k] = length;
      speeds[k] = speed;
    }
  }

  const distance = new Map<number, number>([[kept[0] as number, 0]]);
  kept.slice(1).forEach((i, k) => {
    distance.set(i, (distance.get(kept[k] as number) ?? 0) + (lengths[k] as number));
  });
  const along = (i: number) => distance.get(i) ?? 0;
  dropImplausible(
    alive,
    (h, i, j) => {
      const before = at(i).time - at(h).time;
      const after = at(j).time - at(i).time;
      const steady = along(h) + ((along(j) - along(h)) * before) / (before + after);
      return Math.abs(along(i) - steady) / allowed(PLAUSIBLE.longitudinal, before, after);
    },
    (i) => repairs.push({ kind: 'lag', time: at(i).time }),
  );

  const final = alive.flatMap((isAlive, i) => (isAlive ? [i] : []));
  const distances = final.map(along);
  return {
    track: { points: final.map(at), distances, length: distances.at(-1) ?? 0 },
    repairs: repairs.sort((a, b) => a.time - b.time),
  };
}
