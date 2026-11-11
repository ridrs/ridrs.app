// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { DARK_ZONES, LIGHT_ZONES, paletteSlot } from './palette.ts';

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB. */
const BLINDNESS = {
  none: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const;

function lab(hex: string, kind: keyof typeof BLINDNESS): [number, number, number] {
  const lin = rgb(hex).map(linear);
  const m = BLINDNESS[kind];
  const [r, g, b] = m.map((row) =>
    Math.min(1, Math.max(0, (row[0] ?? 0) * (lin[0] ?? 0) + (row[1] ?? 0) * (lin[1] ?? 0) + (row[2] ?? 0) * (lin[2] ?? 0))),
  ) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const distance = (a: string, b: string, kind: keyof typeof BLINDNESS) => {
  const [l1, a1, b1] = lab(a, kind);
  const [l2, a2, b2] = lab(b, kind);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

describe('the zone palette', () => {
  for (const [name, colours] of [
    ['dark', DARK_ZONES],
    ['light', LIGHT_ZONES],
  ] as const) {
    for (const kind of Object.keys(BLINDNESS) as (keyof typeof BLINDNESS)[]) {
      it(`keeps neighbouring zones apart in ${name} for ${kind}`, () => {
        const worst = Math.min(
          ...colours.slice(1).map((colour, i) => distance(colours[i] as string, colour, kind)),
        );
        expect(worst).toBeGreaterThan(14);
      });
    }
  }

  it('spreads seven zones over the ten colours, rising', () => {
    const slots = [1, 2, 3, 4, 5, 6, 7].map((zone) => paletteSlot(zone, 7));
    expect(slots[0]).toBe(0);
    expect(slots.at(-1)).toBe(9);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(7);
  });

  it('takes ten zones one to one and clamps more', () => {
    expect([1, 5, 10].map((zone) => paletteSlot(zone, 10))).toEqual([0, 4, 9]);
    expect(paletteSlot(12, 12)).toBe(9);
  });
});
