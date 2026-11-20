import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getVersion } from "@tauri-apps/api/app";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import type { Api } from "./api";

export function createTauriApi(): Api {
  const ev = <T>(name: string, cb: (p: T) => void) => listen<T>(name, (e) => cb(e.payload)).then(() => undefined);
  return {
    mock: false,
    settingsGet: () => invoke("settings_get"),
    settingsSet: (settings) => invoke("settings_set", { settings }),
    envCheck: () => invoke("env_check"),
    projectList: () => invoke("project_list"),
    projectCreate: (name, video) => invoke("project_create", { name, video: video ?? null }),
    projectSave: (id, data) => invoke("project_save", { id, data }),
    projectDelete: (id) => invoke("project_delete", { id }),
    projectOpen: (id) => invoke("project_open", { id }),
    allowVideo: (path) => invoke("allow_video", { path }),
    mediaUrl: (path) => invoke("media_url", { path }),
    videoProbe: (path) => invoke("video_probe", { path }),
    videoPoster: (project, path, t, hdr) => invoke("video_poster", { project, path, t, hdr }),
    videoPlayback: (project, path, codec) => invoke("video_playback", { project, path, codec }),
    videoFrames: (project, path, step, hdr) => invoke("video_frames", { project, path, step, hdr }),
    pbfList: () => invoke("pbf_list"),
    pbfLink: (path) => invoke("pbf_link", { path }),
    pbfRemove: (path) => invoke("pbf_remove", { path }),
    geofabrikCandidates: (bbox) => invoke("geofabrik_candidates", { bbox }),
    pbfDownload: (id, url, file) => invoke("pbf_download", { id, url, file }),
    pbfDownloadCancel: () => invoke("pbf_download_cancel"),
    geoSearch: (q) => invoke("geo_search", { q }),
    geoSuggest: (title) => invoke("geo_suggest", { title }),
    pipelineStart: (params) => invoke("pipeline_start", { params }),
    pipelineStatus: () => invoke("pipeline_status"),
    pipelineCancel: () => invoke("pipeline_cancel"),
    pipelineRetime: (project, startTime) => invoke("pipeline_retime", { project, startTime }),
    resultLoad: (project) => invoke("result_load", { project }),
    gpxExport: (project, dest, ele = true) => invoke("gpx_export", { project, dest, ele }),
    hintImport: (project, src) => invoke("hint_import", { project, src }),
    hintRead: (project, path) => invoke("hint_read", { project, path }),
    atlasJobRead: (path) => invoke("atlas_job_read", { path }),
    atlasHintDownload: (project, url, name) => invoke("atlas_hint_download", { project, url, name }),
    atlasResultWrite: (dest, text) => invoke("atlas_result_write", { dest, text }),
    appVersion: () => getVersion(),
    hintRemove: (project) => invoke("hint_remove", { project }),
    // contract of plan-ui section 8: commands import_templates / import_resolve / import_preview / import_start / import_status, event import-progress
    importTemplates: () => invoke("import_templates"),
    importResolve: (project, req) => invoke("import_resolve", { project, req }),
    importPreview: (template, input) => invoke("import_preview", { template, input }),
    importStart: (project, req) => invoke("import_start", { project, req }),
    importStatus: () => invoke("import_status"),
    onImportProgress: (cb) => ev<any>("import-progress", cb),
    importCancel: () => invoke("import_cancel"),
    reveal: (path) => invoke("reveal", { path }),
    incyclistInfo: (project, video, options, online) => invoke("incyclist_info", { project, video, options, online }),
    incyclistExport: (project, video, options, dest) => invoke("incyclist_export", { project, video, options, dest }),
    incyclistCancel: () => invoke("incyclist_cancel"),
    incyclistPreviewSet: (project, path) => invoke("incyclist_preview_set", { project, path }),
    incyclistPreviewClear: (project) => invoke("incyclist_preview_clear", { project }),
    demStatus: (project, online) => invoke("dem_status", { project, online }),
    profileLoad: (project, recompute) => invoke("profile_load", { project, recompute: recompute ?? false }),
    profileDiag: (project) => invoke("profile_diag", { project }),
    inspectSeries: (project) => invoke("inspect_series", { project }),
    inspectFrame: (project, t, video, what) => invoke("inspect_frame", { project, t, video, what }),
    demDownload: (tiles, project) => invoke("dem_download", { tiles, project: project ?? null }),
    demCancel: () => invoke("dem_cancel"),
    demList: () => invoke("dem_list"),
    demRemove: (name) => invoke("dem_remove", { name }),
    geoCountry: (lat, lon) => invoke("geo_country", { lat, lon }),
    onIncyclistProgress: (cb) => ev<any>("incyclist-progress", cb),
    onIncyclistDone: (cb) => ev<any>("incyclist-done", cb),
    onDemProgress: (cb) => ev<any>("dem-progress", cb),
    onDemDone: (cb) => ev<any>("dem-done", cb),
    fileUrl: (path) => convertFileSrc(path),
    onPipelineEvent: (cb) => ev<{ project: string; event: any }>("pipeline-event", (p) => cb(p.project, p.event)),
    onPipelineExit: (cb) => ev<{ project: string; code: number | null; cancelled: boolean }>("pipeline-exit", (p) => cb(p.project, p.code, p.cancelled)),
    onImportLog: (cb) => ev<{ project: string; stream: string; line: string }>("import-log", (p) => cb(p.project, p.stream, p.line)),
    onImportDone: (cb) => ev<any>("import-done", cb),
    onDownloadProgress: (cb) => ev<any>("download-progress", cb),
    onDownloadDone: (cb) => ev<any>("download-done", cb),
    onFileDrop: async (cb, hover) => {
      await getCurrentWebview().onDragDropEvent((e) => {
        const t = e.payload.type;
        if (t === "enter" || t === "over") hover(true);
        else if (t === "leave") hover(false);
        else if (t === "drop") { hover(false); cb(e.payload.paths); }
      });
    },
    pickVideo: async () => {
      const r = await open({ multiple: false, directory: false, title: "Video wählen",
        filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "ts"] }] });
      return typeof r === "string" ? r : null;
    },
    pickPbf: async () => {
      const r = await open({ multiple: false, directory: false, title: "Vorhandene .osm.pbf-Datei wählen", filters: [{ name: "OSM-Extrakt", extensions: ["pbf"] }] });
      return typeof r === "string" ? r : null;
    },
    pickFile: async (title) => {
      const r = await open({ multiple: false, directory: false, title });
      return typeof r === "string" ? r : null;
    },
    pickImage: async () => {
      const r = await open({ multiple: false, directory: false, title: "Vorschaubild wählen (PNG oder JPEG)", filters: [{ name: "Bild", extensions: ["png", "jpg", "jpeg"] }] });
      return typeof r === "string" ? r : null;
    },
    pickHint: async () => {
      const r = await open({ multiple: false, directory: false, title: "Routenhinweis wählen (GPX oder KML)", filters: [{ name: "GPX / KML", extensions: ["gpx", "kml"] }] });
      return typeof r === "string" ? r : null;
    },
    pickJob: async () => {
      const r = await open({ multiple: false, directory: false, title: "Job-Datei des Atlas öffnen", filters: [{ name: "Atlas-Job", extensions: ["json"] }] });
      return typeof r === "string" ? r : null;
    },
    pickSaveAtlas: async (defaultName) => {
      const r = await save({ title: "Ergebnis für den Atlas speichern", defaultPath: defaultName, filters: [{ name: "Atlas-Ergebnis", extensions: ["json"] }] });
      return r ?? null;
    },
    pickSave: async (defaultName) => {
      const r = await save({ title: "GPX speichern", defaultPath: defaultName, filters: [{ name: "GPX", extensions: ["gpx"] }] });
      return r ?? null;
    },
    pickSavePackage: async (defaultName, folder) => {
      const r = await save(folder
        ? { title: "Ordner für Incyclist anlegen (Name des neuen Ordners)", defaultPath: defaultName }
        : { title: "Für Incyclist speichern", defaultPath: `${defaultName}.zip`, filters: [{ name: "ZIP", extensions: ["zip"] }] });
      return r ?? null;
    },
    confirm: (message) => ask(message, { title: "video2gpx", kind: "warning", okLabel: "Ja", cancelLabel: "Nein" }),
  };
}
