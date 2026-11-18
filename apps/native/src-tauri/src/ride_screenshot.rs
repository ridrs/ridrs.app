// SPDX-License-Identifier: AGPL-3.0-or-later

//! The rider's screenshot of a ride (ADR 0102): the native snapshot of the web view, as it is,
//! written as a JPEG straight into the recordings, so the picture never crosses the IPC. The name
//! comes from the JS side (`screenshot-tauri`); the path must lie below `recordings`. The Mac
//! only for now; elsewhere the command says so.

use tauri::Manager;

use crate::app_files;

/// JPEG quality: a picture of the ride, small enough to keep many.
#[cfg(target_os = "macos")]
const QUALITY: f64 = 0.9;

/// Takes a screenshot of the main window's web view and writes it to the app file `path`, a
/// `.jpg` below `recordings`. Resolves once the file is written.
#[tauri::command]
pub async fn ride_screenshot(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if !path.ends_with(".jpg") {
        return Err(format!("invalid screenshot path \"{path}\""));
    }
    let file = app_files::resolve(window.app_handle(), &path, &["recordings"])?;
    if let Some(directory) = file.parent() {
        std::fs::create_dir_all(directory).map_err(|e| format!("{path}: {e}"))?;
    }
    take(&window, &file).await
}

#[cfg(target_os = "macos")]
async fn take(window: &tauri::WebviewWindow, file: &std::path::Path) -> Result<(), String> {
    crate::web_snapshot::take(window, None, file, crate::web_snapshot::Format::Jpeg(QUALITY)).await
}

#[cfg(not(target_os = "macos"))]
async fn take(_window: &tauri::WebviewWindow, _file: &std::path::Path) -> Result<(), String> {
    Err("Screenshots are not available on this platform".into())
}
