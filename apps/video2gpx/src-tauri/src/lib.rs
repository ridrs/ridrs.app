#![recursion_limit = "256"]
pub mod atlas;
pub mod ctx;
pub mod geo;
pub mod import;
pub mod inspect;
pub mod incyclist;
pub mod media;
pub mod pbf;
pub mod pipeline;
pub mod proc;
pub mod projects;
pub mod settings;
pub mod video;

use ctx::Ctx;
use serde_json::Value;
use std::path::Path;
use tauri::{Emitter, Manager, State};

type R<T> = Result<T, String>;

#[tauri::command]
fn settings_get(ctx: State<Ctx>) -> settings::Settings {
    settings::load(&ctx)
}
#[tauri::command]
fn settings_set(ctx: State<Ctx>, settings: settings::Settings) -> R<()> {
    settings::save(&ctx, &settings)
}
#[tauri::command]
async fn env_check(ctx: State<'_, Ctx>) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pipeline::env_check(&c)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn project_list(ctx: State<Ctx>) -> Vec<Value> {
    projects::list(&ctx)
}
#[tauri::command]
fn project_create(ctx: State<Ctx>, name: String, video: Option<String>) -> R<Value> {
    projects::create(&ctx, &name, video)
}
#[tauri::command]
fn project_save(ctx: State<Ctx>, id: String, data: Value) -> R<()> {
    projects::save(&ctx, &id, data)
}
#[tauri::command]
fn project_delete(ctx: State<Ctx>, id: String) -> R<()> {
    projects::delete(&ctx, &id)
}
/// Opens a project and lets the web view's asset protocol read its video, poster and frames (and nothing else).
#[tauri::command]
fn project_open(app: tauri::AppHandle, ctx: State<Ctx>, id: String) -> R<Value> {
    let v = projects::open(&ctx, &id)?;
    allow_project_assets(&app, &v);
    let mut s = settings::load(&ctx);
    s.last_project = Some(id);
    let _ = settings::save(&ctx, &s);
    Ok(v)
}

fn allow_project_assets(app: &tauri::AppHandle, open: &Value) {
    let scope = app.asset_protocol_scope();
    if let Some(v) = open["app"]["video"].as_str() {
        let _ = scope.allow_file(v);
    }
    if let Some(d) = open["dir"].as_str() {
        let _ = scope.allow_file(Path::new(d).join("poster.jpg"));
        let _ = scope.allow_directory(Path::new(d).join("frames"), true);
        for e in ["png", "jpg"] {
            let _ = scope.allow_file(Path::new(d).join(format!("incyclist_preview.{e}")));
        }
    }
}

#[tauri::command]
fn allow_video(app: tauri::AppHandle, path: String) -> R<()> {
    app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())
}
/// http URL of the local media server for a video (streaming without blocking the window, see media.rs)
#[tauri::command]
fn media_url(media: State<media::Media>, path: String) -> R<String> {
    media.register(&path)
}
#[tauri::command]
async fn video_probe(ctx: State<'_, Ctx>, path: String) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || video::probe(&c, &path)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn video_poster(app: tauri::AppHandle, ctx: State<'_, Ctx>, project: String, path: String, t: f64, hdr: bool) -> R<String> {
    let c = ctx.inner().clone();
    let r = tauri::async_runtime::spawn_blocking(move || video::poster(&c, &project, &path, t, hdr)).await.map_err(|e| e.to_string())??;
    let _ = app.asset_protocol_scope().allow_file(&r);
    Ok(r)
}
#[tauri::command]
async fn video_playback(ctx: State<'_, Ctx>, project: String, path: String, codec: String) -> R<String> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || video::playback(&c, &project, &path, &codec)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn video_frames(app: tauri::AppHandle, ctx: State<'_, Ctx>, project: String, path: String, step: f64, hdr: bool) -> R<Value> {
    let c = ctx.inner().clone();
    let r = tauri::async_runtime::spawn_blocking(move || video::frames(&c, &project, &path, step, hdr)).await.map_err(|e| e.to_string())??;
    if let Some(d) = r["dir"].as_str() {
        let _ = app.asset_protocol_scope().allow_directory(d, true);
    }
    Ok(r)
}

#[tauri::command]
fn pbf_list(ctx: State<Ctx>) -> Vec<Value> {
    pbf::list(&ctx)
}
#[tauri::command]
fn pbf_link(ctx: State<Ctx>, path: String) -> R<Value> {
    pbf::link(&ctx, &path)
}
#[tauri::command]
fn pbf_remove(ctx: State<Ctx>, path: String) -> R<()> {
    pbf::remove(&ctx, &path)
}
#[tauri::command]
async fn geofabrik_candidates(ctx: State<'_, Ctx>, bbox: [f64; 4]) -> R<Vec<Value>> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pbf::geofabrik_candidates(&c, &bbox)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn pbf_download(ctx: State<Ctx>, id: String, url: String, file: String) -> R<()> {
    pbf::download(&ctx, &id, &url, &file)
}
#[tauri::command]
fn pbf_download_cancel(ctx: State<Ctx>) {
    pbf::download_cancel(&ctx)
}

#[tauri::command]
async fn geo_search(ctx: State<'_, Ctx>, q: String) -> R<Vec<Value>> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || geo::search(&c, &q, 5)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn geo_suggest(ctx: State<'_, Ctx>, title: String) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || geo::suggest(&c, &title)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn pipeline_start(ctx: State<Ctx>, params: pipeline::RunParams) -> R<()> {
    pipeline::start(&ctx, params)
}
#[tauri::command]
fn pipeline_status(ctx: State<Ctx>) -> Option<String> {
    pipeline::status(&ctx)
}
#[tauri::command]
fn pipeline_cancel(ctx: State<Ctx>) -> bool {
    pipeline::cancel(&ctx)
}
#[tauri::command]
async fn pipeline_retime(ctx: State<'_, Ctx>, project: String, start_time: String) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pipeline::retime(&c, &project, &start_time)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn result_load(ctx: State<Ctx>, project: String) -> R<Value> {
    projects::result_load(&ctx, &project)
}
#[tauri::command]
async fn gpx_export(ctx: State<'_, Ctx>, project: String, dest: String, ele: Option<bool>) -> R<Value> {
    // may compute the elevation profile (a pipeline run): off the main thread
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || projects::gpx_export(&c, &project, &dest, ele.unwrap_or(true))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn hint_import(ctx: State<Ctx>, project: String, src: String) -> R<Value> {
    pipeline::hint_import(&ctx, &project, &src)
}
#[tauri::command]
fn hint_read(ctx: State<Ctx>, project: String, path: String) -> R<String> {
    pipeline::hint_read(&ctx, &project, &path)
}
#[tauri::command]
fn hint_remove(ctx: State<Ctx>, project: String) -> R<()> {
    pipeline::hint_remove(&ctx, &project)
}

/// The text of an atlas job file (`*.v2g.json`); the frontend parses it (src/atlas.ts).
#[tauri::command]
fn atlas_job_read(path: String) -> R<String> {
    atlas::job_read(&path)
}
/// Downloads the atlas route of a job as the project's route hint (network only on opening a job, the user's action).
#[tauri::command]
async fn atlas_hint_download(ctx: State<'_, Ctx>, project: String, url: String, name: String) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || atlas::hint_download(&c, &project, &url, &name)).await.map_err(|e| e.to_string())?
}
/// Writes `<id>.atlas.json` to the place chosen in the save dialog.
#[tauri::command]
fn atlas_result_write(dest: String, text: String) -> R<Value> {
    atlas::result_write(&dest, &text)
}

/// Built-in import templates and the user's (the user's are saved through `settings_set`).
#[tauri::command]
fn import_templates(ctx: State<Ctx>) -> Vec<settings::ImportTemplate> {
    import::templates(&settings::load(&ctx))
}
/// The exact line a stored template would run for this input (project null: with a sample folder), with its problems.
#[tauri::command]
async fn import_resolve(ctx: State<'_, Ctx>, project: Option<String>, req: import::ImportRequest) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || import::resolve_request(&c, project.as_deref(), &req).map(|r| r.to_json())).await.map_err(|e| e.to_string())?
}
/// The same for a template text of the editor, before it is saved.
#[tauri::command]
async fn import_preview(ctx: State<'_, Ctx>, template: String, input: String) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || import::preview(&c, &template, &input).map(|r| r.to_json())).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn import_start(ctx: State<Ctx>, project: String, req: import::ImportRequest) -> R<()> {
    import::start(&ctx, &project, &req)
}
#[tauri::command]
fn import_cancel(ctx: State<Ctx>) -> bool {
    import::cancel(&ctx)
}
#[tauri::command]
fn import_status(ctx: State<Ctx>) -> Option<Value> {
    import::status(&ctx)
}

#[tauri::command]
async fn incyclist_info(ctx: State<'_, Ctx>, project: String, video: String, options: incyclist::ExportOptions, online: bool) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || incyclist::info(&c, &project, &options, &video, online)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn incyclist_export(ctx: State<Ctx>, project: String, video: String, options: incyclist::ExportOptions, dest: String) -> R<()> {
    incyclist::export(&ctx, &project, &video, options, &dest)
}
/// the preview image of the Incyclist package: checked, copied into the project folder, shown through the asset protocol
#[tauri::command]
fn incyclist_preview_set(app: tauri::AppHandle, ctx: State<Ctx>, project: String, path: String) -> R<String> {
    let p = incyclist::preview_set(&ctx, &project, &path)?;
    let _ = app.asset_protocol_scope().allow_file(&p);
    Ok(p.to_string_lossy().to_string())
}
#[tauri::command]
fn incyclist_preview_clear(ctx: State<Ctx>, project: String) -> R<()> {
    incyclist::preview_clear(&ctx, &project)
}
#[tauri::command]
fn incyclist_cancel(ctx: State<Ctx>) -> bool {
    incyclist::cancel(&ctx)
}
#[tauri::command]
async fn profile_load(ctx: State<'_, Ctx>, project: String, recompute: Option<bool>) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || incyclist::profile_load(&c, &project, recompute.unwrap_or(false))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn profile_diag(ctx: State<'_, Ctx>, project: String) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || incyclist::profile_diag(&c, &project)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn inspect_series(ctx: State<'_, Ctx>, project: String) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || inspect::inspect_series(&c, &project)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn inspect_frame(ctx: State<'_, Ctx>, project: String, t: f64, video: Option<String>, what: Option<String>) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || inspect::inspect_frame(&c, &project, t, video, what)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn dem_status(ctx: State<'_, Ctx>, project: String, online: bool) -> R<Value> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || incyclist::dem_status(&c, &project, online)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn dem_download(ctx: State<Ctx>, tiles: Vec<String>, project: Option<String>) -> R<()> {
    incyclist::dem_download(&ctx, tiles, project)
}
#[tauri::command]
fn dem_cancel(ctx: State<Ctx>) {
    incyclist::dem_cancel(&ctx)
}
#[tauri::command]
fn dem_list(ctx: State<Ctx>) -> Vec<Value> {
    incyclist::dem_list(&ctx)
}
#[tauri::command]
fn dem_remove(ctx: State<Ctx>, name: String) -> R<()> {
    incyclist::dem_remove(&ctx, &name)
}
#[tauri::command]
async fn geo_country(ctx: State<'_, Ctx>, lat: f64, lon: f64) -> R<Option<String>> {
    let c = ctx.inner().clone();
    tauri::async_runtime::spawn_blocking(move || geo::country(&c, lat, lon)).await.map_err(|e| e.to_string())?
}

/// Shows the file in the Finder (Mac) or the file manager (Linux: selected through the freedesktop FileManager1 interface, else
/// its folder opened with xdg-open).
#[tauri::command]
fn reveal(path: String) -> R<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(path).status().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        use std::process::{Command, Stdio};
        let p = std::path::Path::new(&path);
        let uri = format!("file://{}", file_uri_path(&path));
        let shown = Command::new("dbus-send")
            .args(["--session", "--dest=org.freedesktop.FileManager1", "--type=method_call", "/org/freedesktop/FileManager1"])
            .args(["org.freedesktop.FileManager1.ShowItems", &format!("array:string:{uri}"), "string:"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if shown {
            return Ok(());
        }
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// The path part of a file:// URI: every byte outside the unreserved set and "/" percent-encoded.
#[cfg(not(target_os = "macos"))]
fn file_uri_path(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let handle = app.handle().clone();
            let emit: ctx::Emit = std::sync::Arc::new(move |name, payload| {
                let _ = handle.emit(name, payload);
            });
            app.manage(Ctx::new(data_dir, emit));
            app.manage(media::Media::start()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get, settings_set, env_check,
            project_list, project_create, project_save, project_delete, project_open,
            allow_video, media_url, video_probe, video_poster, video_playback, video_frames,
            pbf_list, pbf_link, pbf_remove, geofabrik_candidates, pbf_download, pbf_download_cancel,
            geo_search, geo_suggest,
            pipeline_start, pipeline_status, pipeline_cancel, pipeline_retime, result_load, gpx_export,
            hint_import, hint_read, hint_remove, atlas_job_read, atlas_hint_download, atlas_result_write, import_templates, import_resolve, import_preview, import_start, import_cancel, import_status, reveal,
            incyclist_info, incyclist_export, incyclist_cancel, incyclist_preview_set, incyclist_preview_clear, dem_status, dem_download, dem_cancel, dem_list, dem_remove, geo_country, profile_load, profile_diag, inspect_series, inspect_frame,
        ])
        .run(tauri::generate_context!())
        .expect("error while running video2gpx");
}
