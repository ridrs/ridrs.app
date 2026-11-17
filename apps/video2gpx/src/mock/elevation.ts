// The elevation of the browser mock: a profile with its diagnostics (two sources, a tunnel, a void-filled stretch, a stretch where the sources
// disagree), the sources of the route and a download with progress. Scenarios: hoehe, hoehe-missing, hoehe-old (mock/scenarios.ts).
import type { DemStatus, ElevationDiag, ElevationProfile, ProfileLoad, ProfileStatus } from "../types";
import { DEM_TILE } from "./fixtures";
import { SC, qp } from "./scenarios";

const LEN = 1700, DS = 5, N = Math.floor(LEN / DS) + 1;
const TILE_BYTES = 43_277_344, BLOCK_BYTES = 34_000_000, BLOCKS = 4;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const truth = (s: number) => 420 + 22 * Math.sin(s / 300) + 2.5 * Math.sin(s / 45);
/** deterministic pseudo noise in [-1, 1] */
const noise = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 0.5 + Math.sin(i * 4.1414 + k * 1.7) * 0.5;
const inRange = (s: number, a: number, b: number) => s >= a && s <= b;

export const state = {
  tile: qp("dem") !== "missing" && SC.elev !== "missing",
  extras: SC.elev === "extra-have",
  /** the profile was made (and is current) */
  computed: false,
  /** the first profile that is returned is stale (made by older code) */
  stale: SC.elev === "stale",
  cancel: false,
  downloading: false,
};

const ARCS = Array.from({ length: N }, (_, i) => i * DS);
/** what each source measured: Copernicus (a surface model: canopy, errors in the tunnel, the filled stretch and where it disagrees), the national terrain model */
function samples() {
  const cop = ARCS.map((s, i) => {
    let z = truth(s) + noise(i, 1) * 1.2 + (noise(i, 5) > 0.55 ? 4 + 5 * Math.abs(noise(i, 6)) : 0);          // trees: only too high
    if (inRange(s, 300, 380)) z += 34 + 6 * noise(i, 2);                                                       // over a tunnel: the hill
    if (inRange(s, 600, 700)) z += 16 * Math.sin(i * 0.9);                                                      // void-filled pixels
    if (inRange(s, 1000, 1150)) z += 9 + noise(i, 3);                                                           // the sources disagree
    return z;
  });
  const dtm = ARCS.map((s, i) => truth(s) + noise(i, 4) * 0.35);
  return { cop, dtm };
}
/** P13 alone: Copernicus filtered, so it follows the disagreement partly and flattens the detail; tunnel and bridge interpolated */
function p13() {
  const { cop } = samples();
  const out = ARCS.map((s, i) => {
    const a = Math.max(0, i - 20), b = Math.min(N - 1, i + 20);
    let m = 0; for (let j = a; j <= b; j++) m += inRange(ARCS[j], 285, 395) ? truth(ARCS[j]) : cop[j]; m /= b - a + 1;
    const t = truth(s);
    return 0.55 * m + 0.45 * (t + 0.6 * (m - t) * 0.4);
  });
  const i0 = Math.round(285 / DS), i1 = Math.round(395 / DS);
  for (let i = i0; i <= i1; i++) out[i] = out[i0] + ((out[i1] - out[i0]) * (i - i0)) / (i1 - i0);
  return out;
}

function ascentOf(z: number[], hyst = 3): [number, number] {
  let up = 0, down = 0, ref = z[0];
  for (const v of z.slice(1)) { if (v - ref >= hyst) { up += v - ref; ref = v; } else if (ref - v >= hyst) { down += ref - v; ref = v; } }
  return [up, down];
}

const sources = () => [{ name: "copernicus", title: "Copernicus DEM GLO-30", licence: "Copernicus DEM licence", attribution: "Copernicus DEM GLO-30 © DLR e.V. and Airbus Defence and Space GmbH, provided under COPERNICUS by the EU and ESA" },
  ...(state.extras ? [{ name: "fr_rgealti", title: "IGN RGE ALTI (Frankreich)", licence: "Licence Ouverte 2.0", attribution: "IGN RGE ALTI, Licence Ouverte 2.0 (Etalab)" }] : [])];

function finalZ(): number[] { const p = p13(); return ARCS.map((s, i) => round(state.extras ? truth(s) + 0.4 * noise(i, 9) : p[i], 1)); }

export function profile(): ElevationProfile {
  const z = finalZ(), [up, down] = ascentOf(z), src = sources();
  return { version: 1, ds: DS, s0: 0, z, ascent_m: round(up, 0), descent_m: round(down, 0), min_m: Math.min(...z), max_m: Math.max(...z),
    source: src.map((x) => x.title).join(" + "), attribution: src.map((x) => x.attribution).join("; "), sources: src, pipeline_hash: "0123456789abcdef",
    diag: SC.elev === "old" ? undefined : "elevation_diag.json", tunnel: ARCS.map((s, i) => (inRange(s, 300, 380) ? i : -1)).filter((i) => i >= 0) };
}

export function diag(): ElevationDiag | null {
  if (SC.elev === "old") return null;
  const z = finalZ(), p = p13(), { cop, dtm } = samples(), [up, down] = ascentOf(z), [up13, down13] = ascentOf(p);
  const gap = ARCS.map((s) => (inRange(s, 285, 395) ? 1 : 0)), filled = ARCS.map((s) => (inRange(s, 590, 710) ? 1 : 0));
  const rug = ARCS.map((s, i) => round(Math.max(0, Math.min(1, 0.15 + (inRange(s, 560, 760) ? 0.7 : 0) + (inRange(s, 1000, 1150) ? 0.35 : 0) + 0.08 * noise(i, 7))), 2));
  const robust = state.extras;
  const copW = ARCS.map((s, i) => round(robust ? (inRange(s, 285, 395) ? 0.04 : inRange(s, 600, 700) ? 0.12 + 0.1 * Math.abs(noise(i, 8)) : inRange(s, 1000, 1150) ? 0.15 : noise(i, 5) > 0.55 ? 0.1 : 0.75 + 0.2 * Math.abs(noise(i, 10))) : 0, 2));
  const dtmW = ARCS.map((s, i) => round(inRange(s, 285, 395) ? 0.9 : 0.93 + 0.07 * Math.abs(noise(i, 11)), 2));
  const wDtm = ARCS.map((s) => (robust ? round(Math.max(0, Math.min(1, inRange(s, 0, 40) ? s / 40 : 1)), 2) : 0));
  const shDtm = ARCS.map((_, i) => (robust ? round(wDtm[i] * (0.78 + 0.1 * noise(i, 12)), 2) : 0));
  const src = [{ name: "copernicus", title: "Copernicus DEM GLO-30", colour: 0, z: cop.map((v) => round(v, 1)), w: robust ? copW : null, sh: shDtm.map((v) => round(1 - v, 2)) },
    ...(robust ? [{ name: "fr_rgealti", title: "IGN RGE ALTI (Frankreich)", colour: 1, z: dtm.map((v) => round(v, 1)), w: dtmW, sh: shDtm }] : [])];
  return { version: 2, ds: DS, s0: 0, n: N, pipeline_hash: "0123456789abcdef", z_p13: p.map((v) => round(v, 1)), rug, filled, gap, w_dtm: wDtm, sources: src,
    strategy_share: { robust: robust ? 0.97 : 0, p13: robust ? 0.03 : 1 }, source_share: robust ? { copernicus: 0.22, fr_rgealti: 0.78 } : { copernicus: 1 },
    max_grade_pct: round(Math.max(...z.slice(10).map((v, i) => Math.abs(v - z[i]) / 50 * 100)), 1), ascent_p13_m: round(up13, 0), descent_p13_m: round(down13, 0), ascent_m: round(up, 0), descent_m: round(down, 0) };
}

export function dem(): DemStatus {
  const have = state.extras ? BLOCKS : 1;
  return { tiles: [{ name: DEM_TILE, state: state.tile ? "present" : "missing", bytes: TILE_BYTES }], ready: state.tile, missing_bytes: state.tile ? 0 : TILE_BYTES, exact: true, dir: "/app/dem",
    extras: { sources: {
      cop_flm: { title: "Copernicus Füllmaske (FLM)", kind: "mask", region: "weltweit", blocks: 1, missing: state.tile || state.extras ? 0 : 1, missing_bytes: state.tile || state.extras ? 0 : 1_200_000, licence: "Copernicus DEM licence", attribution: "Copernicus", status: "verified" },
      nasadem: { title: "NASADEM (SRTM neu verarbeitet)", kind: "fill", region: "weltweit, 30 m", blocks: 1, missing: 0, missing_bytes: 0, conditional: false, licence: "Public Domain", attribution: "NASA", status: "verified" },
      fr_rgealti: { title: "IGN RGE ALTI (Frankreich)", kind: "dtm", region: "Frankreich, 1 m", blocks: BLOCKS, missing: BLOCKS - have, missing_bytes: (BLOCKS - have) * BLOCK_BYTES, licence: "Licence Ouverte 2.0", attribution: "IGN", status: "verified" },
    }, missing_blocks: (state.tile || state.extras ? 0 : 1) + (BLOCKS - have), missing_bytes: (state.tile || state.extras ? 0 : 1_200_000) + (BLOCKS - have) * BLOCK_BYTES, exact: false },
    extra_missing_bytes: (state.tile || state.extras ? 0 : 1_200_000) + (BLOCKS - have) * BLOCK_BYTES };
}

export function profileStatus(): ProfileStatus {
  if (!state.tile || !state.computed) return { state: "missing" };
  if (state.stale) return { state: "stale", reason: "pipeline" };
  const p = profile();
  return { state: "current", source: p.source, ascent_m: p.ascent_m, descent_m: p.descent_m };
}

export function load(recompute: boolean): ProfileLoad {
  if (!state.tile) return { ready: false, reason: "dem_missing", dem: dem() };
  const wasStale = state.stale;
  if (wasStale && recompute) state.stale = false;
  state.computed = true;
  return { ready: true, profile: profile(), stale: wasStale && !recompute, stale_reason: wasStale && !recompute ? "pipeline" : null };
}

/** download what is missing: the Copernicus tile (progress in bytes), then the route's extra blocks (progress per block) */
export function download(fire: (n: string, p: any) => void, wait: (ms: number) => Promise<unknown>, frozen: boolean): void {
  state.cancel = false; state.downloading = true;
  void (async () => {
    const tick = frozen ? 0 : 140;
    if (!state.tile) {
      for (let b = 0; b <= TILE_BYTES + 1; b += 4_000_000) {
        if (state.cancel) { state.downloading = false; fire("demd", { ok: false, cancelled: true }); return; }
        fire("demp", { index: 0, of: 1, bytes: Math.min(b, TILE_BYTES), total: TILE_BYTES }); await wait(tick);
      }
      state.tile = true;
    }
    if (!state.extras) {
      for (let i = 0; i <= BLOCKS - 1; i++) {
        if (state.cancel) { state.downloading = false; fire("demd", { ok: false, cancelled: true }); return; }
        fire("demp", { index: i, of: BLOCKS - 1, bytes: i * BLOCK_BYTES, total: 0, extra: true }); await wait(tick * 3);
      }
      state.extras = true; state.computed = false;
    }
    state.downloading = false;
    fire("demd", { ok: true });
  })();
}
