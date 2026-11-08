// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import type { Messages } from './i18n/index.ts';

/** The route ridden last until the rider rides another: the demo course, always on the device. */
export const FIRST_ROUTE = 'ui-landscape-demo/demo-course';

export type Filter = 'flat' | 'hilly' | 'short' | 'favourites';

export const FILTERS: readonly Filter[] = ['flat', 'hilly', 'short', 'favourites'];

const providerOf = (offer: RouteOffer) => offer.id.slice(0, offer.id.indexOf('/'));

/**
 * The offers of the app state `route.offer` in the ride page's order: by provider (the plugin id
 * that starts every offer id), then by title. Every plugin start orders them alike.
 */
export function orderOffers(offers: Iterable<RouteOffer>): RouteOffer[] {
  return [...offers].sort(
    (a, b) => providerOf(a).localeCompare(providerOf(b)) || a.title.localeCompare(b.title),
  );
}

/** m climbed per km from which a route counts as hilly. */
const HILLY = 10;

/** The offers that pass every chosen filter, in their order. A course without an end is not short. */
export function filterRoutes(
  offers: readonly RouteOffer[],
  filters: readonly Filter[],
  favourites: readonly string[],
): RouteOffer[] {
  return offers.filter((offer) => {
    const hilly = offer.distance > 0 && offer.ascent / (offer.distance / 1000) >= HILLY;
    return filters.every((filter) => {
      switch (filter) {
        case 'flat':
          return !hilly;
        case 'hilly':
          return hilly;
        case 'short':
          return offer.duration !== undefined && offer.duration < 45 * 60;
        case 'favourites':
          return favourites.includes(offer.id);
      }
    });
  });
}

/** A route's length as the rider reads it: `46.1 km`. */
export const formatDistance = (offer: RouteOffer, text: Messages): string => `${text.km(offer.distance)} km`;

/** A route's climb as the rider reads it: `1216 m`. */
export const formatAscent = (offer: RouteOffer, text: Messages): string => text.metres(offer.ascent);

/** A categorised climb's name: `HC` or `Cat 1` to `Cat 4` (ADR 0070). */
export type Climb = NonNullable<RouteOffer['climbs']>[number];
export const climbCategory = (climb: Climb, text: Messages): string => text.category(climb.category);

/** A categorised climb in the route details, e.g. `Cat 1: summit 1244 m at km 14.3 · 14.3 km at 4.9 %`. */
export function describeClimb(climb: Climb, text: Messages): string {
  return text.describeClimb(
    climbCategory(climb, text),
    climb.summit,
    text.km(climb.end),
    text.km(climb.end - climb.start),
    climb.grade,
  );
}

/** What the route details say over its picture: what it is and where, e.g. `Video · France · Grimone, part 1`. */
export function describeRoute(offer: RouteOffer, text: Messages): string {
  const { country, tour } = offer.tags;
  return [
    offer.kind === 'video' ? text.video : text.route,
    country && (text.countries[country] ?? country),
    tour && text.part(tour.name, tour.part),
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
}

/**
 * The gradient bands of a route's profile, from the flattest up. A band's `label` names it in
 * the page's data; the rider reads `Messages.grades` at the same index, as in the catalog's profile
 * picture (ADR 0070); a descent counts as flat. The steepest band is a dark purple instead of the
 * picture's black, which would vanish on the app's dark background.
 */
export const GRADES = [
  { label: 'below 2 %', below: 2, colour: '#8fbf5a' },
  { label: '2–4 %', below: 4, colour: '#f2cd2f' },
  { label: '4–6 %', below: 6, colour: '#f0962a' },
  { label: '6–8 %', below: 8, colour: '#df4b2b' },
  { label: '8–10 %', below: 10, colour: '#a11d2b' },
  { label: '10 % and more', below: Number.POSITIVE_INFINITY, colour: '#6a1b6e' },
] as const;

export type Grade = (typeof GRADES)[number];

/** The band of a gradient in %. */
export const gradeOf = (grade: number): Grade => GRADES.find(({ below }) => grade < below) ?? GRADES[5];

/**
 * A stretch of the profile between two of its points: from and to in m along the route, the
 * elevations there, its own gradient and the gradient over `TREND` m around it, in %.
 */
export interface Stretch {
  readonly from: number;
  readonly to: number;
  readonly low: number;
  readonly high: number;
  readonly grade: number;
  readonly trend: number;
}

/** m around a stretch whose gradient colours it: GPS elevations jitter from one sample to the next. */
const TREND = 500;

/**
 * The route's profile as stretches from start to end; none without elevations. Its points are the
 * evenly spaced elevations and each categorised summit at its altitude: the summits lie between
 * the samples, which would cut their tops off and leave their markers beside the peak.
 */
export function stretchesOf(offer: RouteOffer): Stretch[] {
  const elevations = offer.sparkline ?? [];
  const step = offer.distance / Math.max(elevations.length - 1, 1);
  const points = [
    ...elevations.map((elevation, i) => ({ at: i * step, elevation })),
    ...(elevations.length > 1 ? (offer.climbs ?? []) : []).map((climb) => ({ at: climb.end, elevation: climb.summit })),
  ].sort((a, b) => a.at - b.at);
  const end = points.at(-1)?.at ?? 0;
  const elevationAt = (at: number) => {
    const next = points.findIndex((point) => point.at >= at);
    const b = points[Math.max(next, 0)] ?? { at, elevation: 0 };
    const a = points[next - 1];
    return a && b.at > a.at ? a.elevation + ((b.elevation - a.elevation) * (at - a.at)) / (b.at - a.at) : b.elevation;
  };
  return points.slice(1).flatMap((to, i) => {
    const from = points[i] ?? to;
    const length = to.at - from.at;
    if (length <= 0) return [];
    const middle = (from.at + to.at) / 2;
    const start = Math.max(0, Math.min(middle - TREND / 2, end - TREND));
    const stop = Math.min(end, start + TREND);
    const trend = stop > start ? ((elevationAt(stop) - elevationAt(start)) / (stop - start)) * 100 : 0;
    const grade = ((to.elevation - from.elevation) / length) * 100;
    return [{ from: from.at, to: to.at, low: from.elevation, high: to.elevation, grade, trend }];
  });
}

/** How long a ride takes about, as the rider reads it: `about 2 h 53 min`, `about 44 min`. */
export function formatDuration(seconds: number, text: Messages): string {
  return text.about(Math.round(seconds / 60));
}

/** A download's size as the rider reads it: `11.2 GB`, `770 MB`. */
export function formatSize(bytes: number, text: Messages): string {
  return text.size(bytes);
}
