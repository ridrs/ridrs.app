// The example result behind fixtures/result.example.json: a synthetic run of the example job's video (150 s, 1.5 km due east from
// 7.0° E, 45.0° N). Decoded from 5 s to 145 s at 10 m/s, a sure standstill 60-65 s, a measurement gap 100-104 s, extrapolated at both ends.
import type { AtlasPoint, AtlasQcState } from "../../src/atlas.ts";

const LON_PER_M = 1 / (111320 * Math.cos(Math.PI / 4));
const LAT = 45 - 1.6 / 111320; // the driving line 1.6 m right of an eastbound centre line
const r7 = (x: number) => Math.round(x * 1e7) / 1e7;

/** the atlas route of the example job, as the hint parser gives it: [lat, lon] */
export const exampleHint: [number, number][][] = [Array.from({ length: 31 }, (_, i) => [45, 7 + i * 50 * LON_PER_M] as [number, number])];

const arcAt = (t: number) => (t <= 5 ? 0 : t <= 60 ? 10 * (t - 5) : t <= 65 ? 550 : t <= 145 ? 550 + 10 * (t - 65) : 1350);
export const examplePoints: AtlasPoint[] = Array.from({ length: 151 }, (_, t) => {
  const arc = arcAt(t), extrapolated = t < 5 || t > 145, gap = t >= 100 && t <= 104, still = t >= 60 && t <= 65;
  return { t, lat: r7(LAT), lon: r7(7 + arc * LON_PER_M), heading: 90, confidence: extrapolated ? 0 : gap ? 0.6 : 0.95, in_gap: gap, extrapolated,
    sd_m: 2, arc_m: arc, offset_m: 1.6, motion_state: still ? "standstill" : gap ? "gap" : "driving" };
});
export const exampleStandstills: [number, number][] = [[60, 65]];
/** the elevation profile: 400 m at the start, 5 % up */
export const exampleEleAt = (arc: number) => 400 + 0.05 * arc;
export const exampleState = (): AtlasQcState => ({ result: "r1", t_start: 5, t_end: 145, overrides: {}, cuts_checked: [], viewed: { start: true, turn: true, end: true }, note: "Beispiel" });
export const exampleRun = { verdict: "confident" as const, verdict_basis: "no decoys: calibration peak, posterior and coverage", pipeline_hash: "0123456789abcdef", vehicle: "car", offset_m: 1.6, app_version: "0.1.0" };
