// The mock scenarios: ?mock=<name>. Each one is a set of switches; the route (hash) picks the view, so any view can be
// opened in any scenario. Without a hash the scenario's own route is used. Old names stay as aliases.
import type { Verdict } from "../types";

export interface Scenario {
  /** default route when the URL has no hash */
  route: string;
  /** what the environment check reports */
  env?: "ok" | "noff" | "noytdlp" | "nopipeline";
  /** the demo project: full (frame, map, no result), fresh (video, no frame, the title search runs), noframe, nomap, novideo, videomissing */
  project?: "full" | "fresh" | "noframe" | "nomap" | "novideo" | "videomissing" | "nosuggest";
  result?: Verdict;
  difficult?: boolean;
  hints?: "hints" | "frames";
  /** a run at boot: frozen in step 4, three steps at once, waiting for the import, or a stored end */
  run?: "running" | "start" | "parallel" | "stream" | "cancelled" | "failed";
  import?: "running" | "error";
  /** no projects at all */
  empty?: boolean;
  dev?: boolean;
  offline?: boolean;
  /** the video cannot be played: the frame fallback */
  frames?: boolean;
  /** no import template for addresses */
  notemplate?: boolean;
  export?: "running" | "done";
  /** the Höhe stage: the Copernicus tile is missing, a profile of older code, a profile without diagnostics, or all national data present */
  elev?: "missing" | "stale" | "old" | "extra-have";
  /** the Analyse stage: "bad" = a route with five weak stretches of different causes (the default result has one) */
  analyse?: "bad";
}

const P = "#/p/demo-1/";
const IMP = "#/p/demo-import/einrichten";
export const SCENARIOS: Record<string, Scenario> = {
  // WP-C: start, tools, import, settings
  start: { route: "#/", empty: true },
  recent: { route: "#/" },
  notemplate: { route: "#/", notemplate: true },
  tools: { route: "#/werkzeuge", env: "noff" },
  "tools-ytdlp": { route: "#/werkzeuge", env: "noytdlp" },
  "tools-nopipeline": { route: "#/werkzeuge", env: "nopipeline" },
  import: { route: IMP, import: "running" },
  "import-error": { route: IMP, import: "error" },
  templates: { route: "#/einstellungen" },
  dev: { route: "#/einstellungen", dev: true },
  // WP-D: Einrichten, Kartendaten
  project: { route: P + "einrichten", project: "full" },
  fresh: { route: P + "einrichten", project: "fresh" },
  nosuggest: { route: P + "einrichten", project: "nosuggest" },
  noframe: { route: P + "einrichten", project: "noframe" },
  nomap: { route: P + "einrichten", project: "nomap" },
  novideo: { route: P + "einrichten", project: "novideo" },
  videomissing: { route: P + "einrichten", project: "videomissing" },
  offline: { route: P + "einrichten", project: "full", offline: true },
  mapdata: { route: "#/kartendaten" },
  frames: { route: P + "einrichten", project: "full", hints: "frames" },
  // WP-E: Berechnung
  running: { route: P + "berechnung", run: "running" },
  "running-start": { route: P + "berechnung", run: "start" },
  "running-parallel": { route: P + "berechnung", run: "parallel" },
  "running-stream": { route: P + "berechnung", run: "stream", import: "running" },
  cancelled: { route: P + "berechnung", run: "cancelled" },
  failed: { route: P + "berechnung", run: "failed" },
  // WP-F: Ergebnis, Export
  result: { route: P + "ergebnis", result: "confident" },
  uncertain: { route: P + "ergebnis", result: "uncertain" },
  noroute: { route: P + "ergebnis", result: "no_route" },
  difficult: { route: P + "ergebnis", result: "confident", difficult: true },
  hints: { route: P + "ergebnis", result: "confident", hints: "hints" },
  "result-frames": { route: P + "ergebnis", result: "confident", frames: true },
  export: { route: P + "export", result: "confident" },
  "export-uncertain": { route: P + "export", result: "uncertain" },
  "export-running": { route: P + "export", result: "confident", export: "running" },
  "export-done": { route: P + "export", result: "confident", export: "done" },
  // Höhe
  hoehe: { route: P + "hoehe", result: "confident" },
  "hoehe-full": { route: P + "hoehe", result: "confident", elev: "extra-have" },
  "hoehe-missing": { route: P + "hoehe", result: "confident", elev: "missing" },
  "hoehe-stale": { route: P + "hoehe", result: "confident", elev: "stale" },
  "hoehe-old": { route: P + "hoehe", result: "confident", elev: "old" },
  // Analyse
  analyse: { route: P + "analyse", result: "confident" },
  "analyse-bad": { route: P + "analyse", result: "uncertain", analyse: "bad" },
  selfcheck: { route: "#/_selfcheck" },
};
const ALIAS: Record<string, string> = { empty: "start", noenv: "tools" };

const q = new URLSearchParams(location.search);
export const scenarioName = ((n) => ALIAS[n] ?? n)(q.get("mock") ?? "recent");
export const SC: Scenario = SCENARIOS[scenarioName] ?? SCENARIOS.recent;
/** extra switches: &dem=missing, &video=webm, &hint=kml, &total=unknown, &at=<pct|start> */
export const qp = (k: string) => q.get(k);
