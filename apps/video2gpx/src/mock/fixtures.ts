// Fixed data of the browser mock: one route, the video probe, local maps, status signals and the events of a finished run.
import { SC } from "./scenarios";
import type { PbfInfo, PipelineEvent, RoutePoint, StepId, Verdict, VideoProbe } from "../types";

export const CENTER: [number, number] = [44.7506, 5.264];
export const VIDEO_S = 180;
export const STEP_IDS: StepId[] = ["motion", "rotation", "map", "route_search", "plausibility", "refine", "gpx"];

/** the Analyse scenario "analyse-bad": five weak stretches (15-30, 52-60, 100-115, 128-142, 160-171 s) */
export const BAD_RUNS: [number, number][] = [[15, 30], [52, 60], [100, 115], [128, 142], [160, 171]];
const badConf = (t: number) => (BAD_RUNS.some(([a, b]) => t >= a && t <= b) ? 0.04 + 0.35 * Math.abs(Math.sin(t * 1.7)) : t > 70 && t < 92 ? 0.62 + 0.1 * Math.sin(t) : 0.97);

function makeRoute(): RoutePoint[] {
  const pts: RoutePoint[] = [];
  let lat = CENTER[0] - 0.004, lon = CENTER[1] - 0.012;
  for (let t = 0; t <= VIDEO_S; t++) {
    const h = 60 + 55 * Math.sin(t / 26) + 30 * Math.sin(t / 9);
    const r = (h * Math.PI) / 180, v = 9;
    const conf = t < 3 ? 0 : SC.analyse === "bad" ? badConf(t) : t > 70 && t < 92 ? 0.62 + 0.1 * Math.sin(t) : t > 128 && t < 142 ? 0.3 : 0.97;
    pts.push({ t, lat, lon, heading: (h + 360) % 360, confidence: conf, in_gap: t > 150 && t < 156, extrapolated: t < 3, sd_m: 8, arc_m: t * v, offset_m: 1.5 });
    lat += (v * Math.cos(r)) / 111200;
    lon += (v * Math.sin(r)) / (111320 * Math.cos((lat * Math.PI) / 180));
  }
  return pts;
}
export const ROUTE = makeRoute();

export const PROBE: VideoProbe = { path: "/mock/test.mp4", title: "Rousset - 3 - Pontaix, Chamaloc", duration: VIDEO_S, codec: "h264", width: 3840, height: 2160, hdr: false, container: "mov,mp4", creation_time: "2026-05-01T08:30:00Z", bytes: 1_724_974_835, ext: "mp4" };

export const PBFS: PbfInfo[] = [
  { path: "/Users/demo/osm/rhone-alpes.osm.pbf", name: "rhone-alpes.osm.pbf", bytes: 612_000_000, bbox: [44.1, 3.7, 46.6, 7.3], linked: true, missing: false },
  { path: "/app/osm/liguria.osm.pbf", name: "liguria.osm.pbf", bytes: 98_000_000, bbox: [43.7, 7.4, 44.7, 10.1], linked: false, missing: false },
];

export const DEM_TILE = "Copernicus_DSM_COG_10_N44_00_E005_00_DEM";

export function statuses(verdict: Verdict, difficult: boolean): Record<string, PipelineEvent> {
  return {
    motion: { type: "status", signal: "motion_coverage", level: "good", value: 0.997, message: "100 % of the video time has usable motion (1 segments)" },
    area1: { type: "status", signal: "area_size", level: "good", value: 1.05, message: "nominal route length 17.0 km x upper scale 3.5 = 59 km against the area diagonal 57 km (40 x 40 km)" },
    rotation: { type: "status", signal: "rotation_quality", level: difficult ? "difficult" : "good", value: difficult ? 4.1 : 1.4, message: "heading noise 1.4x the bike level; far-feature fit in 96 % of the windows" },
    peak: { type: "status", signal: "calibration_peak", level: verdict === "no_route" ? "problem" : verdict === "uncertain" ? "difficult" : "good", value: 19.9, message: "peak at f_eff 461, distance scale 1.22; interior, 19.9 nats/km above the surface median" },
    area2: { type: "status", signal: "area_size", level: "good", value: 0, message: "the route is within 300 m of the area edge for 0 % of the time" },
  };
}

export const HINT_STATUSES: PipelineEvent[] = [
  { type: "status", signal: "start_frame", level: "good", value: 0, message: "the decoded start lies inside the start frame" },
  { type: "status", signal: "hint_corridor", level: "good", value: 2.4, message: "route found inside the 300 m corridor of the hint (31 road km)" },
  { type: "status", signal: "hint_agreement", level: "good", value: 0.97, message: "97 % of the decoded route lies within 300 m of the route hint (information only)" },
];

/** the events of steps 1..n done (the statuses they report included) */
export function stepsDone(n: number, st: Record<string, PipelineEvent>, hints: boolean): PipelineEvent[] {
  const ev: PipelineEvent[] = [];
  STEP_IDS.slice(0, n).forEach((id, i) => {
    ev.push({ type: "step", id, index: i + 1, of: 7, state: id === "plausibility" ? "skipped" : "done", pct: 100, seconds: [52, 14, 48, 96, 0, 31, 2][i] });
    if (id === "motion") ev.push(st.motion, st.area1);
    if (id === "rotation") ev.push(st.rotation);
    if (id === "route_search") { if (hints) ev.push(...HINT_STATUSES); ev.push(st.peak, st.area2); }
  });
  return ev;
}

export function resultEvents(verdict: Verdict, difficult: boolean, hints: boolean): PipelineEvent[] {
  return [
    ...stepsDone(7, statuses(verdict, difficult), hints),
    { type: "result", verdict, verdict_basis: "without decoy check", gpx: "/mock/out/route.gpx", project: "/mock/out/project.json", route_points: "/mock/out/route_points.json", summary: { vehicle: "bike", route_km: 1.4 } },
    { type: "exit", code: 0, cancelled: false },
  ];
}

/** a coarse hint: the route reduced to 20 points, shifted about 80 m (GPX, or KML with &hint=kml) */
export function hintText(kml: boolean): { name: string; text: string } {
  const pts = ROUTE.filter((_, i) => i % Math.ceil(ROUTE.length / 20) === 0).map((p) => [p.lat + 0.0006, p.lon + 0.0006]);
  if (kml) return { name: "tour.kml", text: `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString><coordinates>${pts.map(([la, lo]) => `${lo},${la},0`).join(" ")}</coordinates></LineString></Placemark></Document></kml>` };
  return { name: "tour.gpx", text: `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${pts.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join("")}</trkseg></trk></gpx>` };
}
