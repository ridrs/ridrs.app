// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Tauri commands of `storage-media-tauri`, `data-fetch-tauri` and `data-archive-tauri`. The
//! media root is `media` in the app data directory; the `ridrs-media://` scheme (protocol.rs)
//! serves it to the WebView, by range for the video world.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State};

use crate::{archive, fetch, files, paths};

/// The HTTP client of all downloads and the cancel flags of the running ones, by job id.
#[derive(Default)]
pub struct MediaState {
    client: reqwest::Client,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// A download's progress, at most four times a second.
#[derive(Clone, Serialize)]
pub struct Progress {
    received: u64,
    size: Option<u64>,
}

const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// `media` in the app data directory: the root of every media path.
pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("media"))
}

/// The media root on this device, for `MediaFiles.location` and the asset URLs.
#[tauri::command]
pub fn media_root(app: AppHandle) -> Result<String, String> {
    let root = root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn media_exists(app: AppHandle, path: String) -> Result<bool, String> {
    files::exists(&root(&app)?, &path)
}

/// Raw bytes, not a JSON array of numbers.
#[tauri::command(async)]
pub fn media_read(app: AppHandle, path: String) -> Result<Response, String> {
    files::read(&root(&app)?, &path).map(Response::new)
}

#[tauri::command(async)]
pub fn media_write(app: AppHandle, path: String, bytes: Vec<u8>) -> Result<(), String> {
    files::write(&root(&app)?, &path, &bytes)
}

#[tauri::command(async)]
pub fn media_move(app: AppHandle, from: String, to: String) -> Result<(), String> {
    files::rename(&root(&app)?, &from, &to)
}

#[tauri::command(async)]
pub fn media_remove(app: AppHandle, path: String) -> Result<(), String> {
    files::remove(&root(&app)?, &path)
}

/// Fetches `url` into the media path `target`, resumable (`fetch.rs`); `job` names it for a cancel.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn media_fetch(
    app: AppHandle,
    state: State<'_, MediaState>,
    job: String,
    url: String,
    target: String,
    expected_etag: Option<String>,
    on_progress: Channel<Progress>,
) -> Result<fetch::Fetched, String> {
    // Only what a source publishes over TLS: the command lies outside tauri-plugin-http's scope.
    if !url.starts_with("https://") {
        return Err(format!("{url}: only https downloads"));
    }
    let target = paths::resolve(&root(&app)?, &target)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.running.lock().map_err(|e| e.to_string())?.insert(job.clone(), cancel.clone());
    let mut last = Instant::now() - PROGRESS_INTERVAL;
    let result = fetch::fetch(&state.client, &target, &url, expected_etag.as_deref(), &cancel, |received, size| {
        if last.elapsed() >= PROGRESS_INTERVAL || size == Some(received) {
            last = Instant::now();
            let _ = on_progress.send(Progress { received, size });
        }
    })
    .await;
    state.running.lock().map_err(|e| e.to_string())?.remove(&job);
    result
}

/// Stops a running download; its part stays for the next fetch.
#[tauri::command]
pub fn media_fetch_cancel(state: State<'_, MediaState>, job: String) -> Result<(), String> {
    if let Some(cancel) = state.running.lock().map_err(|e| e.to_string())?.get(&job) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Unpacks a ZIP of the media storage into a folder of it, off the async runtime.
#[tauri::command]
pub async fn media_extract(app: AppHandle, archive: String, directory: String) -> Result<Vec<String>, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || archive::extract(&root, &archive, &directory))
        .await
        .map_err(|e| e.to_string())?
}
