import type {
  DownloadProgress, EnvCheck, GeoHit, GeofabrikCandidate, OpenProject, PbfInfo, PipelineEvent, ProjectApp,
  Settings, Suggestion, VideoProbe, Bbox, ImportTemplate, ImportRequest, ImportResolved, ImportProgress, ImportDone, IncyclistOptions, IncyclistInfo, IncyclistProgress, IncyclistDone, DemStatus, DemFile, ProfileLoad, ElevationDiag, InspectSeriesLoad, InspectFrame,
} from "./types";

export interface RunParams {
  project: string; video: string; bbox: Bbox; pbf: string; vehicle?: string; offset_m?: number | null;
  start_time?: string | null; resume: boolean; decoys?: number | null;
  start_bbox?: Bbox | null; end_bbox?: Bbox | null;
  hint?: string | null; hint_buffer_m?: number | null; hint_fallback?: string | null;
  /** "on" | "fallback" (pipeline `--bike-paths`); null or missing = roads only */
  bike_paths?: string | null;
  /** user anchors (pipeline `--anchors`, written to the project as anchors.json by the backend); null or missing = none */
  anchors?: { t: number; bbox: Bbox }[] | null;
  /** intro end set by hand (pipeline `--intro-end`); null or missing = from the scene cuts */
  intro_end?: number | null;
  /** with resume: reuse the steps before this one as they are and rerun it and all later ones (pipeline `--from-step`) */
  from_step?: string | null;
  /** the video is still being imported: start now and follow the growing file
   *  (if the file is not processable yet, the backend waits and emits { type: "input" } events) */
  follow_import?: boolean;
}

export interface Api {
  mock: boolean;
  settingsGet(): Promise<Settings>;
  settingsSet(s: Settings): Promise<void>;
  envCheck(): Promise<EnvCheck>;
  projectList(): Promise<ProjectApp[]>;
  projectCreate(name: string, video?: string | null): Promise<ProjectApp>;
  projectSave(id: string, data: ProjectApp): Promise<void>;
  projectDelete(id: string): Promise<void>;
  projectOpen(id: string): Promise<OpenProject>;
  allowVideo(path: string): Promise<void>;
  mediaUrl(path: string): Promise<string>;
  videoProbe(path: string): Promise<VideoProbe>;
  videoPoster(project: string, path: string, t: number, hdr: boolean): Promise<string>;
  /** the file the video panel plays: a one-time MP4 copy for WebM/MKV (WebKit reads those whole into memory) */
  videoPlayback(project: string, path: string, codec: string): Promise<string>;
  videoFrames(project: string, path: string, step: number, hdr: boolean): Promise<{ dir: string; times: number[] }>;
  pbfList(): Promise<PbfInfo[]>;
  pbfLink(path: string): Promise<PbfInfo>;
  pbfRemove(path: string): Promise<void>;
  geofabrikCandidates(bbox: Bbox): Promise<GeofabrikCandidate[]>;
  pbfDownload(id: string, url: string, file: string): Promise<void>;
  pbfDownloadCancel(): Promise<void>;
  geoSearch(q: string): Promise<GeoHit[]>;
  geoSuggest(title: string): Promise<Suggestion>;
  pipelineStart(p: RunParams): Promise<void>;
  pipelineStatus(): Promise<string | null>;
  pipelineCancel(): Promise<boolean>;
  pipelineRetime(project: string, startTime: string): Promise<any>;
  resultLoad(project: string): Promise<{ route_points: string; project: string; gpx: string; gpx_bytes: number }>;
  /** saves the GPX; `ele` (default true): with the heights of the elevation profile. `note`: why it was saved without them */
  gpxExport(project: string, dest: string, ele?: boolean): Promise<{ bytes: number; ele: boolean; note: string | null }>;
  hintImport(project: string, src: string): Promise<{ name: string; path: string; text: string }>;
  hintRead(project: string, path: string): Promise<string>;
  hintRemove(project: string): Promise<void>;
  // POV Drive Atlas (src/atlas.ts): the job file, its route as the hint, the result file
  /** the text of a `*.v2g.json` job file */
  atlasJobRead(path: string): Promise<string>;
  /** downloads the job's route into the project's hint folder (replaces a hint) */
  atlasHintDownload(project: string, url: string, name: string): Promise<{ name: string; path: string; text: string }>;
  /** writes `<id>.atlas.json` */
  atlasResultWrite(dest: string, text: string): Promise<{ path: string; bytes: number }>;
  /** the app's version (tauri.conf.json) */
  appVersion(): Promise<string>;
  // import by template (plan-ui section 8); replaces the free shell command (importDisplay / importRun)
  /** built-in templates and the user's */
  importTemplates(): Promise<ImportTemplate[]>;
  /** the exact line for a stored template; project null: preview with a sample folder */
  importResolve(project: string | null, req: ImportRequest): Promise<ImportResolved>;
  /** the same for a template text that is not saved yet (editor) */
  importPreview(template: string, input: string): Promise<ImportResolved>;
  importStart(project: string, req: ImportRequest): Promise<void>;
  importCancel(): Promise<boolean>;
  /** the running import, after a reload of the web view */
  importStatus(): Promise<ImportProgress | null>;
  onImportProgress(cb: (p: ImportProgress) => void): Promise<void>;
  reveal(path: string): Promise<void>;
  incyclistInfo(project: string, video: string, options: IncyclistOptions, online: boolean): Promise<IncyclistInfo>;
  incyclistExport(project: string, video: string, options: IncyclistOptions, dest: string): Promise<void>;
  incyclistCancel(): Promise<boolean>;
  /** checks a PNG/JPEG and keeps it in the project folder as the package's preview image; returns the stored path */
  incyclistPreviewSet(project: string, path: string): Promise<string>;
  incyclistPreviewClear(project: string): Promise<void>;
  demStatus(project: string, online: boolean): Promise<DemStatus>;
  /** elevation profile of the result (computed when the DEM tiles are present and there is none); a stale one is recomputed only with `recompute` */
  profileLoad(project: string, recompute?: boolean): Promise<ProfileLoad>;
  /** elevation_diag.json of the profile (null: none, e.g. a profile of an older pipeline) */
  profileDiag(project: string): Promise<ElevationDiag | null>;
  /** the Analyse stage: the per-second series of the result and its weak stretches (cached in out/inspect/series.json) */
  inspectSeries(project: string): Promise<InspectSeriesLoad>;
  /** the points tracked at video time t (what: "motion", "rotation" or both); a newer call ends an older one, which then answers `superseded` */
  inspectFrame(project: string, t: number, video: string | null, what: string): Promise<InspectFrame>;
  /** the Copernicus tiles, then (with a project) the national / regional blocks of its route */
  demDownload(tiles: string[], project?: string): Promise<void>;
  demCancel(): Promise<void>;
  demList(): Promise<DemFile[]>;
  demRemove(name: string): Promise<void>;
  geoCountry(lat: number, lon: number): Promise<string | null>;
  onIncyclistProgress(cb: (p: IncyclistProgress) => void): Promise<void>;
  onIncyclistDone(cb: (r: IncyclistDone) => void): Promise<void>;
  onDemProgress(cb: (p: { index: number; of: number; bytes: number; total: number; extra?: boolean }) => void): Promise<void>;
  onDemDone(cb: (r: { ok: boolean; cancelled?: boolean; error?: string; note?: string | null }) => void): Promise<void>;
  fileUrl(path: string): string;
  // events
  onPipelineEvent(cb: (project: string, ev: PipelineEvent) => void): Promise<void>;
  onPipelineExit(cb: (project: string, code: number | null, cancelled: boolean) => void): Promise<void>;
  onImportLog(cb: (project: string, stream: string, line: string) => void): Promise<void>;
  onImportDone(cb: (r: ImportDone) => void): Promise<void>;
  onDownloadProgress(cb: (p: DownloadProgress) => void): Promise<void>;
  onDownloadDone(cb: (r: { id: string; ok: boolean; path?: string; error?: string; cancelled?: boolean }) => void): Promise<void>;
  onFileDrop(cb: (paths: string[]) => void, hover: (over: boolean) => void): Promise<void>;
  // dialogs
  pickVideo(): Promise<string | null>;
  pickPbf(): Promise<string | null>;
  pickFile(title: string): Promise<string | null>;
  pickHint(): Promise<string | null>;
  /** an atlas job file (`*.v2g.json`) */
  pickJob(): Promise<string | null>;
  /** save dialog for `<id>.atlas.json` */
  pickSaveAtlas(defaultName: string): Promise<string | null>;
  pickImage(): Promise<string | null>;
  pickSave(defaultName: string): Promise<string | null>;
  /** save dialog for the Incyclist package: a .zip, or (folder) the name of the folder to create */
  pickSavePackage(defaultName: string, folder: boolean): Promise<string | null>;
  confirm(message: string): Promise<boolean>;
}

export let api: Api;

export async function initApi(): Promise<Api> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  api = isTauri ? (await import("./tauri")).createTauriApi() : (await import("./mock/index")).createMockApi();
  return api;
}
