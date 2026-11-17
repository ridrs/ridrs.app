export type Bbox = [number, number, number, number]; // south, west, north, east

export interface Settings {
  /** "Entwicklermodus: externes Python": only then python / rsm_dir / sidecar are used; otherwise the pipeline bundled in the app runs */
  dev_mode: boolean;
  python: string;
  rsm_dir: string;
  sidecar: string;
  ffmpeg: string;
  ffprobe: string;
  linked_pbfs: string[];
  import_history: string[];
  last_project: string | null;
  suggest_online: boolean;
  // ---- import templates (UI contract, plan-ui section 8). Optional here so that an older backend still loads;
  //      read through features/import.ts (settingsOf) which fills the defaults.
  /** path of yt-dlp; empty = automatic */
  ytdlp?: string;
  /** the user's own templates */
  import_templates?: ImportTemplate[];
  /** template id used for a URL, and for "copy first" of a path ("" = none chosen) */
  import_default_url?: string;
  import_default_copy?: string;
}

export type ToolId = "ffmpeg" | "ffprobe" | "yt-dlp";

/** A command with placeholders. {input} = the URL or path the user typed, {out} = the project's import folder.
 *  The backend substitutes both as single shell-quoted words; the frontend never builds a shell line. */
export interface ImportTemplate {
  id: string;
  name: string;
  template: string;
  /** shipped with the app: read-only in the UI */
  builtin: boolean;
  /** which inputs it is meant for */
  accepts: "url" | "path" | "any";
  /** tool the command needs; the UI disables the import and links to Werkzeuge when it is missing */
  tool: ToolId | null;
}
export interface ImportRequest {
  /** id of a stored or built-in template */
  template_id: string;
  /** URL or path, as typed (trimmed) */
  input: string;
}
export interface ImportResolved {
  /** the exact line that will run, for display */
  display: string;
  /** problems that prevent a run, in German: missing placeholder, empty input, tool missing, … */
  errors: string[];
  /** notes that do not prevent a run (Rust: import::Resolved.warnings) */
  warnings?: string[];
  /** the arguments as they are passed (no shell), for information */
  argv?: string[];
  tool: ToolCheck | null;
}
export interface ImportProgress {
  project: string;
  phase: "starting" | "downloading" | "finishing";
  /** percentage as the tool printed it (when bytes / total are not known) */
  pct?: number | null;
  /** null when the command prints no usable progress */
  bytes: number | null;
  total: number | null;
  rate: number | null;
  eta_s: number | null;
  /** the video's title as soon as the tool reports it (for the search-frame suggestion before the file is complete) */
  title: string | null;
  /** path of the growing file, once it exists */
  file: string | null;
  /** true: the growing file can already be read from the start (a run may begin now) */
  processable?: boolean;
}
export interface ImportDone {
  project: string; ok: boolean; file?: string; error?: string; cancelled?: boolean; code?: number | null;
  /** last lines of the output, for the error block */
  tail?: string[];
}

export interface ToolCheck { ok: boolean; path?: string; message?: string; version?: string; dir?: string; required?: boolean; warning?: string }
export interface EnvCheck {
  python: ToolCheck; rsm: ToolCheck; ffmpeg: ToolCheck; ffprobe: ToolCheck;
  /** the pipeline that will run: bundled sidecar or external python (developer mode), with its frozen version and code hash */
  pipeline?: { mode: "sidecar" | "python"; version: string | null; code_hash: string | null };
  dev_mode?: boolean;
  data_dir: string; cache_dir: string;
  /** yt-dlp: optional tool, same lookup as ffmpeg (setting, PATH, Homebrew). Optional: an older backend does not send it. */
  ytdlp?: ToolCheck;
  /** Homebrew itself, to choose the install hint (ok: brew found) */
  brew?: ToolCheck;
  /** Rust std::env::consts::OS ("macos", "linux"); optional: an older backend does not send it */
  os?: string;
  /** the install command of this system without package names ("brew install", "sudo apt install"), null if none is known */
  install_cmd?: string | null;
}

export interface VideoProbe {
  path: string; title: string; duration: number | null; codec: string | null;
  width: number | null; height: number | null; hdr: boolean; container: string | null;
  creation_time: string | null; bytes: number; ext: string | null;
}

export type Vehicle = "auto" | "bike" | "motorcycle" | "car";
/** "Rad- und Waldwege einbeziehen" (bikes only): off = roads only, auto = a second search with paths when the road result is not reliable, on = always */
export type BikePaths = "off" | "auto" | "on";

export interface RunParamsSaved {
  video: string; bbox: Bbox; pbf: string; vehicle: Vehicle; offset_m: number | null;
  start_time: string | null; decoys: number;
  start_bbox?: Bbox | null; end_bbox?: Bbox | null;
  hint?: string | null; hint_buffer_m?: number | null; hint_fallback?: "auto" | "off";
  bike_paths?: "on" | "fallback" | null;
  /** user anchors ("Ortsangaben", src/anchors.ts): at video time t the camera is inside bbox */
  anchors?: { t: number; bbox: Bbox }[] | null;
  /** intro end set by hand (video s, src/intro.ts; pipeline --intro-end); null or missing = from the scene cuts */
  intro_end?: number | null;
}

/** route hint stored in the project (a copy of the .gpx / .kml in the project folder) */
export interface HintRef { name: string; path: string; buffer_m: number }

export interface ProjectApp {
  id: string; name: string; video: string | null; created: number; updated: number;
  has_result?: boolean;
  probe?: VideoProbe | null;
  poster?: string | null;
  /** the search frame (drawn by the user) */
  bbox?: Bbox | null;
  start_frame?: Bbox | null;
  end_frame?: Bbox | null;
  hint?: HintRef | null;
  /** user anchors ("Ortsangaben", drawn in the result view; src/anchors.ts) */
  anchors?: { t: number; bbox: Bbox }[] | null;
  /** intro end set by hand in the result view ("Intro-Ende hier setzen", src/intro.ts) */
  intro_end?: number | null;
  suggested?: boolean;
  suggestion?: Suggestion | null;
  pbf?: string | null;
  vehicle?: Vehicle;
  bike_paths?: BikePaths;
  offset_m?: number | null;
  start_time?: string | null;
  decoys?: number;
  last_run?: RunParamsSaved | null;
  /** verdict of the last result, kept by the frontend for the project list (app.json is free-form JSON on the Rust side) */
  verdict?: Verdict | null;
  /** the last options of "Für Incyclist speichern" */
  incyclist?: IncyclistOptions | null;
}

export interface OpenProject {
  app: ProjectApp; dir: string; import_dir: string; out_dir: string; has_result: boolean; events: PipelineEvent[];
}

export interface PbfInfo {
  path: string; name: string; bytes: number; bbox: Bbox | null; linked: boolean; missing: boolean; error?: string;
}

export interface GeofabrikCandidate { id: string; name: string; parent: string; url: string; bytes: number | null; file: string }

export interface GeoHit { name: string; lat: number; lon: number; bbox: Bbox | null; category?: string; type?: string }
export interface Suggestion {
  found: boolean; query?: string; hit?: GeoHit; local_pbf?: string | null; tried: { query: string; hits: number }[];
}

export type StepId = "motion" | "rotation" | "map" | "route_search" | "plausibility" | "refine" | "gpx";
export type StepState = "pending" | "running" | "done" | "failed" | "skipped";
export type Level = "good" | "difficult" | "problem";
export type Verdict = "confident" | "uncertain" | "no_route";

export type PipelineEvent =
  // several steps may be "running" at the same time
  | { type: "step"; id: StepId; index: number; of: number; state: Exclude<StepState, "pending">; pct?: number; eta_s?: number;
      /** set while the step has used up the part of the video that is there and waits for more */
      waiting_for_input?: boolean;
      /** seconds the step took, with state "done" */
      seconds?: number;
      /** state "skipped": the result of an earlier run was reused (resume) */
      reused?: boolean }
  /** how much of the input video is available to the pipeline (only for a run started during an import) */
  | { type: "input"; state: "growing" | "complete"; pct: number | null; bytes: number; total: number | null }
  /** overall progress over all steps, with the remaining time */
  | { type: "progress"; pct: number; eta_s?: number }
  | { type: "status"; signal: string; level: Level; value?: number; message: string }
  | { type: "log"; level: "info" | "warn" | "error" | "stderr"; message: string }
  | { type: "result"; verdict: Verdict; verdict_basis?: string; gpx: string; project: string; route_points: string; summary: Record<string, unknown> }
  | { type: "exit"; code: number | null; cancelled: boolean };

export interface RoutePoint {
  t: number; lat: number; lon: number; heading: number; confidence: number;
  in_gap?: boolean; extrapolated?: boolean; sd_m?: number; arc_m?: number; offset_m?: number;
}

export interface ResultData {
  points: RoutePoint[];
  verdict: Verdict;
  verdict_basis: string;
  reasons: string[];
  project: any;
  gpx: string;
  gpx_bytes: number;
  /** end of the detected intro in video seconds (route_points.json cuts.intro_end), null without one */
  intro_end: number | null;
}

/** options of the Incyclist export (Rust: incyclist::ExportOptions) */
export interface IncyclistOptions {
  title: string; name: string; country: string; drop_audio: boolean; sdr: boolean; max_height: number | null; folder: boolean;
  start_time: string | null;
  /** ignored since the Höhe stage (the download happens there); old saved options still carry it */
  download_dem?: boolean;
  /** URL of the video's source (GPX <link>, video2gpx.json, LIESMICH.txt); null = from the file name, "" = none */
  source_url?: string | null;
  /** convert the video to MP4 (default); false = the source file goes into the package as it is, with its own extension */
  convert?: boolean;
}
export interface IncyclistVideo {
  path: string; name: string; bytes: number; container: string; codec: string; width: number; height: number; r_frame_rate: string; fps: number;
  duration: number; nb_frames: number | null; transfer: string; hdr: boolean; audio: string | null; start_time: number;
}
export interface IncyclistPlan { mode: "copy" | "remux" | "encode" | "original"; reasons: string[]; est_bytes: number; est_seconds: number; out_height: number }
export interface DemTile { name: string; state: "present" | "sea" | "missing"; bytes: number | null }
export interface ElevationSource { name: string; title: string; licence: string; attribution: string }
export interface ElevationProfile {
  version: number; ds: number; s0: number; z: number[]; ascent_m: number; descent_m: number; min_m: number; max_m: number; source: string; attribution: string;
  sources?: ElevationSource[];
  /** file name of the diagnostics next to the profile (pipeline of 15 Nov 2026 and later) */
  diag?: string; pipeline_hash?: string; tunnel?: number[];
}
/** `stale`: the profile was made by other pipeline code or from other source blocks than there are now (Rust: profile_stale) */
export interface ProfileLoad { ready: boolean; reason?: "no_result" | "dem_missing" | "error"; profile?: ElevationProfile; dem?: DemStatus; error?: string; stale?: boolean; stale_reason?: "result" | "pipeline" | "blocks" | "stamp" | null }
/** one source of elevation_diag.json: per grid index the axis sample z, the weight w of the robust estimator (0..1, null where it did not run) and the share sh of the source in the final height */
export interface DiagSource { name: string; title: string; colour: number; z: (number | null)[]; w: (number | null)[] | null; sh: (number | null)[] }
/** `elevation_diag.json` (version 2): what the profile was made of, on the profile's grid (index i = arc s0 + i * ds) */
export interface ElevationDiag {
  version: number; ds: number; s0: number; n: number; pipeline_hash: string | null;
  z_p13: (number | null)[]; rug: (number | null)[]; filled: number[]; gap: number[]; w_dtm: (number | null)[];
  sources: DiagSource[];
  strategy_share: { robust: number; p13: number }; source_share: Record<string, number>;
  max_grade_pct: number; ascent_p13_m: number; descent_p13_m: number; ascent_m: number; descent_m: number;
}
// ---- Analyse stage (rsm.pipeline inspect-series / inspect-frame; docs/FEATURE_analysis_insight.md)
export interface AnalyseCause { id: string; text: string; value: number | null; limit: number | null; unit: string }
export interface AnalyseStretch { t0: number; t1: number; s0: number; s1: number; dur: number; kind: "low" | "none"; conf_min: number; conf_mean: number; causes: AnalyseCause[] }
type NumSeries = (number | null)[];
export interface InspectSeries {
  version: number; pipeline_hash: string | null; result_mtime: number; window_m: number; n: number; t0: number; dt: number; fps: number; f_eff: number | null; kappa: number | null;
  scale_from_route: boolean; intro_end: number | null;
  t: number[]; s: NumSeries;
  /** m/s: the fused speed of the result (ds/dt) and the video's own (vms x kappa; null where the road-flow fit failed) */
  speed_fused: NumSeries; speed_vms: NumSeries;
  /** deg/s, left positive: vms, far features (null where no window fits), the fused one the pipeline uses; pitch (up positive) and roll */
  yaw_vms: NumSeries; yaw_far: NumSeries; yaw: NumSeries; pitch: NumSeries; roll: NumSeries;
  inliers: NumSeries; rms: NumSeries; usable: NumSeries; far_ok: NumSeries; far_inl: NumSeries; far_why: number[]; far_why_text: string[];
  /** 1/km, left positive: the curvature the video measured, the matched map line's, the difference */
  kappa_video: NumSeries; kappa_map: NumSeries; kappa_diff: NumSeries;
  conf: NumSeries; p_search: NumSeries; s_sd: NumSeries;
  in_gap: number[]; extrap: number[]; tunnel: number[]; cut: number[]; odofail: number[]; local: number[];
  cells: { s: number[]; t0: NumSeries; t1: NumSeries; dev: NumSeries; match: NumSeries; turn_v: NumSeries; turn_m: NumSeries };
  odofail_spans: [number, number][]; cuts: [number, number][]; limits: Record<string, number>;
  stretches: AnalyseStretch[]; seconds: number;
}
/** Rust inspect_series: the series (cached or made now), or why not */
export interface InspectSeriesLoad { ready: boolean; reason?: string; error?: string; series?: InspectSeries; cached?: boolean }
/** a tracked point of the overlay: x, y (px of the analysis frame, 360 rows), flow dx, dy (px), 1 = inlier */
export type FramePoint = [number, number, number, number, number];
export interface FrameStoredRow { [column: string]: string }
export interface FrameMotion {
  pair: number; t: number; width: number; height: number; horizon: number; roi: [number, number]; polygon: [number, number][]; points: FramePoint[]; corners: number; tracked: number;
  source: string; row: FrameStoredRow; stored: FrameStoredRow | null; agree: boolean; diff?: Record<string, [string, string]>;
  fit: null | { inliers: number; rms: number | null; s: number; yaw_px: number | null; pitch_px: number | null; roll: number; speed_ms: number | null; yaw_deg_s: number | null; pitch_deg_s: number | null };
  decoded?: number; error?: string;
}
export interface FrameBand {
  band: number; end: number | null; ok: boolean; why: string; n_pts: number; n_inl: number; points: FramePoint[]; usable: boolean; agree: boolean;
  A: number | null; B: number | null; C: number | null; e: number | null; sA: number | null; sigma: number | null;
  stored: { ok: boolean; n_pts: number; n_inl: number; why: string; A: number | null; B: number | null; C: number | null; e: number | null };
}
export interface FrameRotation {
  window: number; ta: number; tb: number; k: number; width: number; height: number; horizon: number | null; band_ends: number[]; bands: FrameBand[]; chosen: number; agree: boolean;
  yaw_deg_s?: number | null; pitch_deg_s?: number | null; error?: string;
}
export interface InspectFrame { ready?: boolean; superseded?: boolean; error?: string; t: number; video: string; fps: number; frame_width: number; frame_height: number; motion?: FrameMotion; rotation?: FrameRotation; seconds: number }
/** what the export dialog shows about the profile (Rust: profile_status) */
export interface ProfileStatus { state: "current" | "stale" | "missing"; reason?: string | null; source?: string; ascent_m?: number; descent_m?: number }
/** the national / regional sources a route can use (rsm.pipeline dem-plan) */
export interface DemExtraSource { title: string; kind: "mask" | "fill" | "dtm"; region: string; blocks: number; missing: number; missing_bytes?: number; conditional?: boolean; licence: string; attribution: string; status: string }
export interface DemExtras { sources: Record<string, DemExtraSource>; missing_blocks: number; missing_bytes: number; exact: boolean }
export interface DemStatus { tiles: DemTile[]; ready: boolean; missing_bytes: number; exact: boolean; dir: string; extras?: DemExtras | null; extra_missing_bytes?: number }
export interface IncyclistInfo { video: IncyclistVideo; plan: IncyclistPlan; dem: DemStatus; profile?: ProfileStatus; est_bytes: number; start: { lat: number | null; lon: number | null }; link: string | null;
  /** the stored preview image of the package (project folder), or null */
  preview?: string | null }
export interface IncyclistProgress { project: string; step: number; of: number; label: string; pct: number; message: string }
export interface IncyclistDone {
  project: string; ok: boolean; cancelled?: boolean; error?: string;
  result?: { path: string; bytes: number; folder: boolean; name: string; id: string; length_m: number; ascent_m: number | null; has_ele: boolean; start_frame: number; note: string | null; seconds: number; plan: IncyclistPlan; video: any };
}
export interface DemFile { name: string; sea: boolean; bytes: number; path: string; source?: boolean; blocks?: number }

export interface DownloadProgress { id: string; bytes: number; total: number; rate: number }
