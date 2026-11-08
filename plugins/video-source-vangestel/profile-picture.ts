// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Climb, Profile } from './climbs.ts';

/**
 * The colour of a km by its gradient (ADR 0070), the front of the profile and its lighter top,
 * from the flattest up; a descent counts as flat.
 */
export const GRADES = [
  { label: 'below 2 %', below: 2, front: '#8fbf5a', top: '#c2df9f' },
  { label: '2–4 %', below: 4, front: '#f2cd2f', top: '#f8e48a' },
  { label: '4–6 %', below: 6, front: '#f0962a', top: '#f7c27f' },
  { label: '6–8 %', below: 8, front: '#df4b2b', top: '#ec8b72' },
  { label: '8–10 %', below: 10, front: '#a11d2b', top: '#cc6670' },
  { label: '10 % and more', below: Number.POSITIVE_INFINITY, front: '#2a2a2a', top: '#6a6a6a' },
] as const;

const gradeOf = (grade: number) => GRADES.find(({ below }) => grade < below) ?? GRADES[5];

const WIDTH = 1600;
const HEIGHT = 640;
const LEFT = 84;
const RIGHT = WIDTH - 48;
const TOP = 200;
const BASE = 500;
/** px the profile's top face reaches back, to the right and up. */
const DEPTH = { x: 10, y: -12 };
const FONT = `font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"`;
const RED = '#d4202c';
const INK = '#2b2b2b';

const px = (value: number) => Number(value.toFixed(1));
const points = (list: readonly (readonly [number, number])[]) => list.map(([x, y]) => `${px(x)},${px(y)}`).join(' ');

/** The m between two altitude lines: at most about 6 of them. */
const altitudeStep = (span: number) => [100, 200, 250, 500, 1000].find((step) => span / step <= 6) ?? 1000;

/**
 * The route's elevation profile as an SVG picture in the style of the big tours' stage profiles:
 * a slab coloured km by km by its gradient, each categorised climb's summit marked with its
 * category, its altitude and its km, an altitude and a km scale and a legend of the colours.
 */
export function drawProfile({ spacing, elevations }: Profile, climbs: readonly Climb[]): string {
  const at = (i: number) => elevations[i] ?? 0;
  const length = Math.max((elevations.length - 1) * spacing, spacing);
  const low = Math.min(...elevations);
  const high = Math.max(...elevations);
  const floor = Math.floor(low / 100) * 100 - 100;
  const span = Math.max(Math.ceil(high / 100) * 100 - floor, 400);
  const x = (distance: number) => LEFT + (distance / length) * (RIGHT - DEPTH.x - LEFT);
  const y = (elevation: number) => BASE - ((elevation - floor) / span) * (BASE - TOP);
  const parts: string[] = [];

  // The altitude scale behind the profile.
  const step = altitudeStep(span);
  for (let altitude = Math.ceil(floor / step) * step; altitude <= floor + span; altitude += step) {
    parts.push(
      `<line x1="${LEFT}" x2="${RIGHT}" y1="${px(y(altitude))}" y2="${px(y(altitude))}" stroke="#d9d4ca" stroke-dasharray="4 6"/>`,
      `<text x="${LEFT - 10}" y="${px(y(altitude) + 5)}" text-anchor="end" font-size="15" fill="#7a746a">${altitude} m</text>`,
    );
  }

  // The slab, km by km: its top face, then its front in the colour of its gradient.
  const perKm = Math.max(1, Math.round(1000 / spacing));
  const kms = Math.ceil((elevations.length - 1) / perKm);
  const inClimb = (distance: number) => climbs.some((climb) => distance > climb.start && distance <= climb.end);
  for (let k = 0; k < kms; k++) {
    const from = k * perKm;
    const to = Math.min(from + perKm, elevations.length - 1);
    const grade = ((at(to) - at(from)) / ((to - from) * spacing)) * 100;
    const colour = gradeOf(grade);
    const line = Array.from({ length: to - from + 1 }, (_, i) => [x((from + i) * spacing), y(at(from + i))] as const);
    const back = line.map(([lx, ly]) => [lx + DEPTH.x, ly + DEPTH.y] as const).reverse();
    parts.push(
      `<polygon points="${points([...line, ...back])}" fill="${colour.top}" stroke="${colour.top}" stroke-width="0.5"/>`,
      `<polygon class="km" data-km="${k + 1}" data-grade="${colour.label}" points="${points([[x(from * spacing), BASE], ...line, [x(to * spacing), BASE]])}" fill="${colour.front}" stroke="#ffffff" stroke-width="1"/>`,
    );
    const width = x(to * spacing) - x(from * spacing);
    const lowest = Math.max(...line.map(([, ly]) => ly));
    if (width >= 24 && BASE - lowest >= 26 && inClimb((to - 0.5) * spacing)) {
      parts.push(
        `<text x="${px(x(((from + to) / 2) * spacing))}" y="${BASE - 9}" text-anchor="middle" font-size="${width >= 32 ? 13 : 11}" font-weight="700" fill="#ffffff">${grade.toFixed(1)}</text>`,
      );
    }
  }
  parts.push(`<polygon points="${points([[LEFT, BASE], [RIGHT - DEPTH.x, BASE], [RIGHT, BASE + DEPTH.y], [RIGHT, BASE + 8], [LEFT, BASE + 8]])}" fill="#57524a"/>`);

  // The km scale.
  const labelEvery = [1, 2, 5, 10, 20, 50].find((every) => length / 1000 / every <= 16) ?? 50;
  for (let km = 0; km * 1000 <= length; km++) {
    const tick = px(x(km * 1000));
    const labelled = km % labelEvery === 0 && length - km * 1000 >= 0.4 * labelEvery * 1000;
    parts.push(`<line x1="${tick}" x2="${tick}" y1="${BASE + 8}" y2="${BASE + (labelled ? 18 : 13)}" stroke="#57524a"/>`);
    if (labelled) {
      parts.push(`<text x="${tick}" y="${BASE + 36}" text-anchor="middle" font-size="15" fill="#57524a">${km}</text>`);
    }
  }
  parts.push(
    `<text x="${px(x(length))}" y="${BASE + 36}" text-anchor="middle" font-size="15" font-weight="700" fill="${INK}">${(length / 1000).toFixed(1)} km</text>`,
  );

  // Start, finish and each summit: a line up to its label, staggered when two come close.
  const flag = (distance: number, elevation: number, raise: number, label: string, sub?: string, badge?: string) => {
    const fx = px(x(distance) + DEPTH.x / 2);
    const fy = px(y(elevation) + DEPTH.y / 2);
    const ly = TOP - 40 - raise;
    const lines = [
      `<line x1="${fx}" x2="${fx}" y1="${fy}" y2="${ly + 8}" stroke="${INK}" stroke-width="1.2"/>`,
      `<circle cx="${fx}" cy="${fy}" r="3.5" fill="${INK}"/>`,
    ];
    if (badge) {
      lines.push(
        `<circle cx="${fx}" cy="${ly - 12}" r="17" fill="${RED}" stroke="#ffffff" stroke-width="2"/>`,
        `<text class="badge" x="${fx}" y="${ly - 6}" text-anchor="middle" font-size="${badge.length > 1 ? 14 : 17}" font-weight="800" fill="#ffffff">${badge}</text>`,
        `<text x="${fx + 24}" y="${ly - 14}" font-size="16" font-weight="700" fill="${INK}">${label}</text>`,
        `<text x="${fx + 24}" y="${ly + 4}" font-size="14" fill="#7a746a">${sub ?? ''}</text>`,
      );
    } else {
      lines.push(`<text x="${fx}" y="${ly}" text-anchor="middle" font-size="15" font-weight="700" fill="${INK}">${label}</text>`);
    }
    return lines.join('');
  };
  let lastX = Number.NEGATIVE_INFINITY;
  let raise = 0;
  for (const climb of climbs) {
    const cx = x(climb.end);
    raise = cx - lastX < 150 && raise === 0 ? 56 : 0;
    lastX = cx;
    const km = `km ${(climb.end / 1000).toFixed(1)}`;
    const label = climb.name ?? `${climb.summit} m`;
    const sub = climb.name ? `${climb.summit} m · ${km}` : km;
    parts.push(`<g class="summit">${flag(climb.end, at(Math.round(climb.end / spacing)), raise, label, sub, climb.category)}</g>`);
  }
  parts.push(
    `<g class="start">${flag(0, at(0), -40, `${Math.round(at(0))} m`)}</g>`,
    `<g class="finish">${flag(length, at(elevations.length - 1), -40, `${Math.round(at(elevations.length - 1))} m`)}</g>`,
  );

  // The legend of the colours.
  const legend = GRADES.map((grade, i) => {
    const lx = LEFT + i * 180;
    return `<rect data-grade="${grade.label}" x="${lx}" y="${HEIGHT - 44}" width="22" height="16" fill="${grade.front}"/><text x="${lx + 30}" y="${HEIGHT - 31}" font-size="14" fill="#57524a">${grade.label}</text>`;
  }).join('');
  parts.push(`<g class="legend">${legend}</g>`);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" ${FONT}>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#f7f4ee"/>`,
    ...parts,
    '</svg>',
    '',
  ].join('\n');
}
