// SPDX-License-Identifier: AGPL-3.0-or-later

import type { VideoColour } from './video-index.ts';

/** ISO/IEC 23091-2 code points the HDR path handles (ADR 0091). */
const BT2020 = 9;
const PQ = 16;

/** Luminance shown as SDR white: the reference white of BT.2408, in cd/m². */
export const REFERENCE_WHITE_NITS = 203;

/**
 * Whether the video is HDR the video world can show as such: PQ with BT.2020 primaries and
 * matrix, as the library's HDR videos are. Others (and HLG) are shown in SDR.
 */
export function isPqBt2020(colour: VideoColour | undefined): colour is VideoColour {
  return colour?.transfer === PQ && colour.primaries === BT2020 && colour.matrix === BT2020;
}

/**
 * The 3 × 4 matrix, row by row, from the sampled 8-bit Y, Cb, Cr (0 to 1, as a texture gives them)
 * and 1 to the non-linear R'G'B' (0 to 1) of BT.2020 non-constant luminance.
 */
export function yuvToRgb(fullRange: boolean): readonly number[] {
  const kr = 0.2627;
  const kb = 0.0593;
  const kg = 1 - kr - kb;
  // Y' = (y - yOffset) * yScale, C = (c - 128/255) * cScale
  const yScale = fullRange ? 1 : 255 / 219;
  const cScale = fullRange ? 1 : 255 / 224;
  const yOffset = fullRange ? 0 : 16 / 255;
  const cOffset = 128 / 255;
  // R' = Y' + rCr Cr; G' = Y' + gCb Cb + gCr Cr; B' = Y' + bCb Cb
  const rCr = 2 * (1 - kr);
  const bCb = 2 * (1 - kb);
  const gCb = (-2 * kb * (1 - kb)) / kg;
  const gCr = (-2 * kr * (1 - kr)) / kg;
  const row = (cb: number, cr: number) => [
    yScale,
    cb * cScale,
    cr * cScale,
    -yOffset * yScale - (cb + cr) * cOffset * cScale,
  ];
  return [...row(0, rCr), ...row(gCb, gCr), ...row(bCb, 0)];
}

/**
 * Linear BT.2020 to linear Display P3 (both D65), column by column as WGSL's `mat3x3f` takes it.
 * Display P3 is the colour space of the HDR canvas (ADR 0091).
 */
export const BT2020_TO_DISPLAY_P3: readonly number[] = [
  1.343578, -0.065297, 0.002822, -0.282180, 1.075788, -0.019598, -0.061399, -0.010490, 1.016777,
];

/** PQ (SMPTE ST 2084) signal 0 to 1 to cd/m². */
export function pqToNits(signal: number): number {
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const p = Math.max(signal, 0) ** (1 / m2);
  return (Math.max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1) * 10000;
}
